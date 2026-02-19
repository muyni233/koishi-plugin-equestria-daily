import { Context, Schema, h, Logger } from 'koishi'

// --- 类型定义 ---
declare module 'koishi' {
  interface Context {
    puppeteer: any
    cron: any
  }
  interface Channel {
    eqdDaily: boolean
    eqdBreaking: boolean
  }
}

export const name = 'eqd-daily'
export const inject = ['puppeteer', 'cron', 'http', 'database']

const logger = new Logger('eqd')

// --- 配置项 ---
export interface Config {
  dailyPushTime: string
  breakingCheckInterval: number
  listCount: number
  randomRange: number 
}

export const Config: Schema<Config> = Schema.object({
  dailyPushTime: Schema.string().default('0 9 * * *').description('每日推送时间 (Cron表达式)'),
  breakingCheckInterval: Schema.number().default(15).description('新闻轮询间隔(分钟)'),
  listCount: Schema.number().default(5).min(1).max(10).description('列表模式获取的新闻条数'),
  randomRange: Schema.number().default(35000).description('随机新闻的抽取范围(建议30000-40000)'),
})

// 修复：NewsItem 接口定义补全
interface NewsItem {
  title: string
  link: string
  pubDate: string | number
  categories: string[]
  content: string
  fullContentFetched: boolean
  wordCount: number
  guid: string // 唯一标识符
}

// 全局缓存
let recentNewsCache: NewsItem[] = [] 
let lastBreakingGuid: string = ''

export function apply(ctx: Context, config: Config) {

  ctx.model.extend('channel', {
    eqdDaily: { type: 'boolean', initial: false },
    eqdBreaking: { type: 'boolean', initial: false },
  })

  // --- HTML 清洗与解码 ---
  function decodeHtml(str: string) {
    if (!str) return ''
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/<img[^>]+feedburner[^>]+>/g, '') // 移除追踪像素
      .replace(/<script[\s\S]*?<\/script>/gi, '') // 移除脚本
  }

  // 估算阅读时间
  function estimateReadTime(text: string): number {
    const plain = text.replace(/<[^>]+>/g, '')
    const words = plain.trim().split(/\s+/).length
    return Math.max(1, Math.ceil(words / 200))
  }

  // 提取封面图 (自动将 s72 小图替换为 s640 大图)
  function extractImage(content: string): string {
    const match = content.match(/<img[^>]+src=["']([^"']+)["']/i)
    if (match && match[1]) {
      // 修复：Blogger 热门列表里的图通常是 /s72-c/ (72x72像素)，替换成 /s640/ 变高清
      return match[1].replace(/\/s\d+(-c)?\//, '/s640/').replace(/s72-c/, 's640')
    }
    // 默认封面
    return 'https://1.bp.blogspot.com/-TeYyZ2d8pGA/XzW4z7t4_OI/AAAAAAABvrM/k0Q6F_k9G4kQyKz2_y2Q5z_z5Q/s1600/EQD_Logo.png'
  }

  // --- 数据获取核心 ---

  // 1. 获取 RSS (List / Random / Daily)
  async function fetchRSS(startIndex = 1, limit = 5): Promise<NewsItem[]> {
    try {
      // Blogger API: start-index=N, max-results=M
      const url = `https://www.equestriadaily.com/feeds/posts/default?alt=rss&start-index=${startIndex}&max-results=${limit}`
      const xml = await ctx.http.get(url, { responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' } })
      
      const items: NewsItem[] = []
      // 兼容 entry (Atom) 和 item (RSS)
      const splitTag = xml.includes('<entry>') ? 'entry' : 'item'
      const parts = xml.split(`<${splitTag}`).slice(1)

      for (const str of parts) {
        const endItem = str.indexOf(`</${splitTag}>`)
        if (endItem === -1) continue
        const contentRaw = str.substring(0, endItem)

        const extract = (tag: string) => {
          const regex = new RegExp(`<${tag}[^>]*?>([\\s\\S]*?)<\\/${tag}>`, 'i')
          const match = contentRaw.match(regex)
          return match ? match[1].trim() : ''
        }
        
        const linkMatch = contentRaw.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']alternate["']/i) || contentRaw.match(/<link>([\s\S]*?)<\/link>/i)
        
        const catRegex = /<category\s+(?:term|text)=["']([^"']+)["']/gi
        const categories: string[] = []
        let catMatch
        while ((catMatch = catRegex.exec(contentRaw)) !== null) categories.push(catMatch[1])

        let rawBody = extract('content') || extract('description')
        const cdataMatch = rawBody.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
        if (cdataMatch) rawBody = cdataMatch[1]
        
        const content = decodeHtml(rawBody)

        items.push({
          title: extract('title').replace(/&amp;/g, '&'),
          link: linkMatch ? (linkMatch[1] || linkMatch[0]) : '',
          pubDate: extract('published') || extract('pubDate'),
          categories: categories,
          content: content,
          fullContentFetched: true,
          wordCount: estimateReadTime(content),
          guid: extract('id') || extract('guid')
        })
      }
      return items
    } catch (e) {
      logger.error('RSS Fetch Error:', e)
      return []
    }
  }

  // 2. 获取 Hot (修复版：基于类名抓取)
  async function fetchHot(): Promise<NewsItem[]> {
    try {
      const html = await ctx.http.get('https://www.equestriadaily.com', { responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' } })
      const items: NewsItem[] = []
      
      // 策略：寻找 <ul class="popular-posts"> ... </ul>
      const listMatch = html.match(/<ul class=['"]popular-posts['"]>([\s\S]*?)<\/ul>/)
      if (!listMatch) {
        logger.warn('Warning: Could not find popular-posts widget in HTML')
        return []
      }
      const listHtml = listMatch[1]
      
      // 分割每一个 <li>
      const itemRegex = /<li>([\s\S]*?)<\/li>/g
      let match
      
      while ((match = itemRegex.exec(listHtml)) !== null) {
        const itemHtml = match[1]
        
        // 提取标题：<div class="post-title"><a href="...">Title</a></div>
        const titleMatch = itemHtml.match(/<div class=['"]post-title['"]>[\s\S]*?<a[^>]+>([\s\S]*?)<\/a>/)
        // 提取链接
        const linkMatch = itemHtml.match(/<div class=['"]post-title['"]>[\s\S]*?<a[^>]+href=['"]([^'"]+)['"]/)
        // 提取封面 (可能在上面的 a 标签里，也可能在 img 标签里)
        const imgMatch = itemHtml.match(/<img[^>]+src=['"]([^'"]+)['"]/)
        
        if (titleMatch && linkMatch) {
          items.push({
            title: decodeHtml(titleMatch[1].trim()),
            link: linkMatch[1],
            pubDate: Date.now(), // 热门榜单没有具体时间，用当前时间占位
            categories: ['HOT', 'POPULAR'],
            content: imgMatch ? `<img src="${imgMatch[1]}">` : '', // 暂存图片，正文需二次抓取
            fullContentFetched: false, // 标记：需要 fetchFullContent
            wordCount: 1, // 占位
            guid: linkMatch[1] // 用链接做唯一ID
          })
        }
        if (items.length >= config.listCount) break
      }
      return items
    } catch (e) {
      logger.error('Hot Fetch Error:', e)
      return []
    }
  }

  // 3. 补充抓取 (针对 Hot 列表的二次解析)
  async function fetchFullContent(item: NewsItem): Promise<NewsItem> {
    try {
      const html = await ctx.http.get(item.link, { responseType: 'text' })
      // 提取正文 div
      const bodyMatch = html.match(/<div class=['"]post-body entry-content[^>]*>([\s\S]*?)<div style=['"]clear: both/i) || 
                        html.match(/<div class=['"]post-body entry-content[^>]*>([\s\S]*?)<\/div>/i)
      
      if (bodyMatch) {
        let content = decodeHtml(bodyMatch[1])
        item.content = content
        item.fullContentFetched = true
        item.wordCount = estimateReadTime(content)
      }
    } catch (e) {
      logger.error('Content Fetch Error', e)
      item.content += '<br><br><i>[正文抓取失败，请点击链接访问原文]</i>'
    }
    return item
  }

  // --- 渲染层 (UI 优化) ---

  async function renderList(items: NewsItem[], title: string, subtitle: string) {
    const listHtml = items.map((item, index) => {
      const img = extractImage(item.content)
      const tag = (item.categories[0] || 'NEWS').toUpperCase()
      // 如果是数字型日期(Hot)，显示 RECENT，否则显示具体日期
      const dateStr = typeof item.pubDate === 'number' 
        ? 'RECENT' 
        : new Date(item.pubDate).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })

      return `
        <div class="card">
          <div class="thumb" style="background-image: url('${img}')"></div>
          <div class="info">
            <div class="meta">
              <span class="tag">${tag}</span>
              <span class="date">${dateStr}</span>
            </div>
            <div class="title">${item.title}</div>
          </div>
          <div class="index-box">${index + 1}</div>
        </div>
      `
    }).join('')

    const html = `
    <html>
    <head>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@500;700;900&display=swap');
      body { margin: 0; padding: 0; width: 440px; font-family: 'Roboto', 'Microsoft YaHei', sans-serif; background: #fff; }
      
      .header { background: #222; padding: 25px; border-bottom: 5px solid #96ce83; }
      .header h1 { color: #fff; margin: 0; font-size: 24px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
      .header p { color: #96ce83; margin: 5px 0 0; font-size: 12px; font-weight: 500; opacity: 0.9; }
      
      .container { padding: 10px 0; }
      
      .card { display: flex; padding: 15px 20px; border-bottom: 1px solid #eee; align-items: center; position: relative; height: 80px; }
      .card:last-child { border-bottom: none; }
      
      .thumb { width: 100px; height: 70px; background-size: cover; background-position: center; border-radius: 4px; flex-shrink: 0; background-color: #f0f0f0; }
      
      .info { margin-left: 15px; flex: 1; padding-right: 30px; display: flex; flex-direction: column; justify-content: center; }
      
      .meta { font-size: 10px; font-weight: 700; margin-bottom: 6px; display: flex; gap: 8px; }
      .tag { color: #96ce83; }
      .date { color: #bbb; }
      
      .title { font-size: 14px; color: #222; font-weight: 700; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      
      /* 明显的序号设计 */
      .index-box { 
        position: absolute; 
        right: 15px; 
        font-size: 32px; 
        font-weight: 900; 
        color: #f2f2f2; 
        font-family: 'Roboto', sans-serif;
        line-height: 1;
        z-index: -1;
      }

      .footer { background: #f9f9f9; padding: 10px; text-align: center; color: #ccc; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
    </style>
    </head>
    <body>
      <div class="header">
        <h1>${title}</h1>
        <p>${subtitle}</p>
      </div>
      <div class="container">${listHtml}</div>
      <div class="footer">Generated by Koishi</div>
    </body>
    </html>
    `
    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    const img = await page.$('body').then(el => el.screenshot({ type: 'png' }))
    await page.close()
    return img
  }

  // 详情页渲染
  async function renderDetail(item: NewsItem) {
    // 深度清洗内容，兼容复杂HTML
    let content = item.content
      .replace(/style="[^"]*"/g, '') 
      .replace(/width=["'][^"']*["']/g, '')
      .replace(/height=["'][^"']*["']/g, '')
      .replace(/<center>/gi, '<div class="center-wrap">') 
      .replace(/<\/center>/gi, '</div>')
    
    // 视频占位符优化
    content = content.replace(/<iframe.*?<\/iframe>/g, 
      '<div class="embed-box"><span>▶ VIDEO CONTENT</span><br>视频无法直接播放，请点击底部链接跳转原文</div>')

    const dateStr = typeof item.pubDate === 'number' 
      ? 'Recently Updated' 
      : new Date(item.pubDate).toLocaleString('zh-CN', { hour12: false })

    const html = `
    <html>
    <head>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700;900&display=swap');
      body { margin: 0; padding: 0; width: 480px; font-family: 'Roboto', 'Microsoft YaHei', sans-serif; background: #fff; color: #333; }
      
      .header { padding: 40px 30px 20px; background: #fff; border-bottom: 1px solid #f0f0f0; }
      
      .meta { font-size: 11px; font-weight: 700; color: #96ce83; letter-spacing: 1px; margin-bottom: 10px; text-transform: uppercase; }
      .title { font-size: 24px; font-weight: 900; color: #111; line-height: 1.3; margin: 0 0 15px; }
      .info { font-size: 12px; color: #999; display: flex; justify-content: space-between; }
      
      .content { padding: 30px; font-size: 16px; line-height: 1.8; color: #333; text-align: justify; }
      
      /* HTML 兼容性样式 */
      .content p { margin-bottom: 1.5em; }
      .content img { display: block; max-width: 100% !important; height: auto !important; border-radius: 6px; margin: 20px auto; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
      .content a { color: #96ce83; text-decoration: none; border-bottom: 1px solid #96ce83; }
      .content blockquote { border-left: 4px solid #222; margin: 20px 0; padding: 10px 20px; background: #f8f8f8; color: #555; font-style: italic; }
      .content ul, .content ol { padding-left: 20px; color: #555; }
      
      /* 表格兼容 */
      .content table { width: 100% !important; display: block; overflow-x: auto; border-collapse: collapse; margin: 20px 0; }
      .content td, .content th { border: 1px solid #ddd; padding: 8px; font-size: 14px; }
      
      .center-wrap { text-align: center; }
      
      .embed-box { background: #222; color: #fff; padding: 30px 20px; text-align: center; border-radius: 8px; margin: 20px 0; font-size: 12px; }
      .embed-box span { font-size: 16px; font-weight: 900; color: #96ce83; display: block; margin-bottom: 5px; }
    </style>
    </head>
    <body>
      <div class="header">
        <div class="meta">${item.categories.slice(0, 3).join(' / ')}</div>
        <div class="title">${item.title}</div>
        <div class="info">
          <span>${dateStr}</span>
          <span>预计阅读 ${item.wordCount} 分钟</span>
        </div>
      </div>
      <div class="content">
        ${content}
      </div>
    </body>
    </html>
    `
    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    const img = await page.$('body').then(el => el.screenshot({ type: 'png' }))
    await page.close()
    return img
  }

  // --- 指令注册 ---

  ctx.command('eqd', 'Equestria Daily')
    .action(() => {
      return `[Equestria Daily]
-------------------
eqd.list    最新资讯 (Latest)
eqd.hot     热门排行 (Popular)
eqd.random  随机考古 (Random)
eqd.read N  阅读详情 (按列表顺序)
eqd.daily   早报设置
eqd.breaking 重大新闻设置
-------------------`
    })

  // 1. 最新
  ctx.command('eqd.list', '查看最新')
    .alias('eqd.ls')
    .action(async () => {
      const items = await fetchRSS(1, config.listCount)
      if (!items.length) return '获取失败，请检查网络。'
      recentNewsCache = items
      const img = await renderList(items, 'LATEST NEWS', 'Equestria Daily 最新资讯')
      return img ? h.image(img, 'image/png') : '渲染失败'
    })

  // 2. 随机 (Random)
  ctx.command('eqd.random', '随机考古')
    .alias('eqd.rd')
    .action(async () => {
      // 随机 start-index
      const max = config.randomRange
      const start = Math.floor(Math.random() * max) + 1
      const items = await fetchRSS(start, config.listCount)
      if (!items.length) return '考古失败，请重试。'
      recentNewsCache = items
      const img = await renderList(items, 'RANDOM ARCHIVE', `Random Pick (Index: ${start})`)
      return img ? h.image(img, 'image/png') : '渲染失败'
    })

  // 3. 热门 (Hot) - 修复版
  ctx.command('eqd.hot', '热门文章')
    .action(async () => {
      const items = await fetchHot()
      if (!items.length) return '无法获取热门列表 (解析失败)。'
      recentNewsCache = items
      const img = await renderList(items, 'POPULAR POSTS', '当前热门文章')
      return img ? h.image(img, 'image/png') : '渲染失败'
    })

  // 4. 阅读
  ctx.command('eqd.read <index:number>', '阅读详情 (请按列表顺序输入序号)')
    .action(async ({ session }, index) => {
      if (!index || index < 1 || index > recentNewsCache.length) return '序号无效，请先获取列表 (list/hot/random)，并按列表顺序输入。'
      
      let item = recentNewsCache[index - 1]
      await session.send('正在渲染...')
      
      // 智能补全：如果是 Hot 列表来源，可能只有标题没有正文，需要二次抓取
      if (!item.fullContentFetched) {
        item = await fetchFullContent(item)
        // 更新缓存
        recentNewsCache[index - 1] = item
      }

      const img = await renderDetail(item)
      return [
        h.image(img, 'image/png'),
        h.text(`\n原文链接: ${item.link}`)
      ]
    })

  // 5. 开关设置
  ctx.command('eqd.daily [switch:string]', '每日早报开关')
    .userFields(['authority'])
    .channelFields(['eqdDaily'])
    .action(async ({ session }, s) => {
      if (session.user.authority < 1) return '权限不足。'
      if (!s) return `状态: ${session.channel.eqdDaily ? '开启' : '关闭'}`
      session.channel.eqdDaily = ['on', '开启'].includes(s)
      return `每日早报已${session.channel.eqdDaily ? '开启' : '关闭'}。`
    })

  ctx.command('eqd.breaking [switch:string]', '重大新闻开关')
    .userFields(['authority'])
    .channelFields(['eqdBreaking'])
    .action(async ({ session }, s) => {
      if (session.user.authority < 1) return '权限不足。'
      if (!s) return `状态: ${session.channel.eqdBreaking ? '开启' : '关闭'}`
      session.channel.eqdBreaking = ['on', '开启'].includes(s)
      return `重大新闻推送已${session.channel.eqdBreaking ? '开启' : '关闭'}。`
    })

  // --- 自动任务 ---
  async function broadcast(img: Buffer, type: 'daily' | 'breaking') {
    const query = type === 'daily' ? { eqdDaily: true } : { eqdBreaking: true }
    const channels = await ctx.database.get('channel', query)
    for (const ch of channels) {
      const bot = ctx.bots.find(b => b.platform === ch.platform) || ctx.bots[0]
      try { await bot?.sendMessage(ch.id, h.image(img, 'image/png')) } catch {}
    }
  }

  ctx.cron(config.dailyPushTime, async () => {
    const items = await fetchRSS(1, 8) 
    if (!items.length) return
    recentNewsCache = items
    const img = await renderList(items, 'DAILY DIGEST', new Date().toLocaleDateString('zh-CN'))
    if (img) await broadcast(img, 'daily')
  })

  ctx.setInterval(async () => {
    const items = await fetchRSS(1, 1)
    if (!items.length) return
    const latest = items[0]
    if (latest.guid === lastBreakingGuid) return

    const title = latest.title.toLowerCase()
    const cats = latest.categories.map(c => c.toLowerCase())
    if (cats.some(c => c.includes('breaking') || c.includes('exclusive')) || title.includes('breaking')) {
      lastBreakingGuid = latest.guid
      logger.info(`Breaking: ${latest.title}`)
      const img = await renderList([latest], 'BREAKING NEWS', '重大新闻')
      if (img) await broadcast(img, 'breaking')
    } else {
      if (!lastBreakingGuid) lastBreakingGuid = latest.guid
    }
  }, config.breakingCheckInterval * 60 * 1000)
}
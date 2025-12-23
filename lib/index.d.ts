import { Context, Schema } from 'koishi';
declare module 'koishi' {
    interface Context {
        puppeteer: any;
        cron: any;
    }
    interface Channel {
        eqdDaily: boolean;
        eqdBreaking: boolean;
    }
}
export declare const name = "eqd-daily";
export declare const inject: string[];
export interface Config {
    dailyPushTime: string;
    breakingCheckInterval: number;
    listCount: number;
    randomRange: number;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;

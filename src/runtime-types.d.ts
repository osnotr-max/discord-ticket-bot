declare const Bun: {
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  Archive: any;
  version: string;
};

declare const process: {
  exit(code?: number): never;
  memoryUsage(): { rss: number };
};

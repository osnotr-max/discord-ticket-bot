declare const Bun: {
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  Archive: any;
  version: string;
  write(path: string, data: string | Uint8Array): Promise<number>;
  file(path: string): { text(): Promise<string> };
};

declare const process: {
  exit(code?: number): never;
  memoryUsage(): { rss: number };
};

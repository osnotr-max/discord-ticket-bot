declare const Bun: {
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  Archive: any;
};

declare const process: {
  exit(code?: number): never;
};

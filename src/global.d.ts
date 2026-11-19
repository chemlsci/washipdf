declare module "*.css";

// ビルド時に esbuild の define で差し込む値
declare namespace NodeJS {
  interface ProcessEnv {
    APP_VERSION?: string;
  }
}

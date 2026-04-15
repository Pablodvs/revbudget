/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // biome-ignore lint/suspicious/noExplicitAny: vue SFC shim needs wide types
  // biome-ignore lint/complexity/noBannedTypes: vue SFC shim needs wide types
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

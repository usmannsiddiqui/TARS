import type { CompanionApi } from "../preload/index";

declare global {
  interface Window {
    companion: CompanionApi;
  }
}

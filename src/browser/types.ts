export interface ChromeProfileInfo {
  readonly directory: string;
  readonly name: string;
  readonly gaiaName?: string | undefined;
  readonly email?: string | undefined;
  readonly avatarUrl?: string | undefined;
  readonly hasPlaywriterExtension: boolean;
  readonly isChromeRunning: boolean;
}

export interface ChromeDiscoveryResult {
  readonly executablePath: string | null;
  readonly userDataDir: string;
  readonly profiles: readonly ChromeProfileInfo[];
  readonly isChromeRunning: boolean;
}

export interface BrowserTabInfo {
  readonly index: number;
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly isJarvisOwned: boolean;
  readonly isCurrent: boolean;
  readonly responsive: boolean;
  readonly titleError: string | null;
}

export interface RelayStatus {
  readonly running: boolean;
  readonly listening: boolean;
  readonly host: string;
  readonly port: number;
  readonly version: string | null;
  readonly connectedExtensions: number | null;
  readonly extensionStatusError: string | null;
}

export interface ConnectedProfileInfo {
  readonly id: string;
  readonly browser: string;
  readonly email: string | null;
  readonly activeTabs: number;
  readonly playwriterVersion: string | null;
}

export interface BrowserReadiness {
  readonly relayRunning: boolean;
  readonly relayListening: boolean;
  readonly relayVersion: string | null;
  readonly extensionCount: number | null;
  readonly selectedBrowserId: string | null;
  readonly enabledTabs: number;
  readonly responsiveTabs: number;
  readonly sessionReady: boolean;
  readonly lastSuccessfulOperation: string | null;
  readonly lastError: string | null;
  readonly recoveryAttempts: number;
}

export interface BrowserReadinessReport {
  readonly readiness: BrowserReadiness;
  readonly elapsedMs: number;
  readonly attempts: number;
}

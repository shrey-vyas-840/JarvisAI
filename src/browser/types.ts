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
}

export interface RelayStatus {
  readonly running: boolean;
  readonly host: string;
  readonly port: number;
  readonly version: string | null;
  readonly connectedExtensions: number;
}

export interface ConnectedProfileInfo {
  readonly id: string;
  readonly browser: string;
  readonly email: string | null;
  readonly activeTabs: number;
  readonly playwriterVersion: string | null;
}

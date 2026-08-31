import type { Profile } from "../domain/profile.js";

export interface EndpointExtraction {
  profileUrl: string;
  voyagerPayloads: unknown[];
  warnings: string[];
}

export interface ScrapeOutput {
  profile: Profile;
  extractionMode: "authenticated" | "public";
  warnings: string[];
}

export interface ProfileScraper {
  scrape(profileUrl: string): Promise<ScrapeOutput>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

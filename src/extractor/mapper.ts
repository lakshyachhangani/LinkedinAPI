import { AppError } from "../domain/errors.js";
import { profileSchema, type Profile } from "../domain/profile.js";
import type { EndpointExtraction, ScrapeOutput } from "./types.js";
import { extractVoyagerData } from "./voyager.js";

export function mapExtraction(raw: EndpointExtraction): ScrapeOutput {
  const publicIdentifier = decodeURIComponent(new URL(raw.profileUrl).pathname.split("/").filter(Boolean).at(-1) ?? "");
  const voyager = extractVoyagerData(raw.voyagerPayloads, publicIdentifier);
  if (!voyager.profile.name) {
    throw new AppError(
      "UPSTREAM_ERROR",
      "LinkedIn endpoints returned data, but no matching profile identity could be extracted",
      502,
      true
    );
  }

  const profile = profileSchema.parse({
    profileUrl: raw.profileUrl,
    ...voyager.profile,
    experience: voyager.experience,
    education: voyager.education,
    skills: voyager.skills,
    certifications: voyager.certifications,
    languages: voyager.languages
  });

  const warnings = [...raw.warnings];
  for (const [field, missing] of [
    ["about", !profile.about],
    ["experience", profile.experience.length === 0],
    ["education", profile.education.length === 0],
    ["skills", profile.skills.length === 0],
    ["certifications", profile.certifications.length === 0],
    ["languages", profile.languages.length === 0]
  ] as const) {
    if (missing) warnings.push(`${field} was not available to the configured LinkedIn session`);
  }

  return { profile, extractionMode: "authenticated", warnings: [...new Set(warnings)] };
}

export function calculateCompleteness(profile: Profile): number {
  const values = [
    profile.name,
    profile.headline,
    profile.location,
    profile.about,
    profile.profileImageUrl,
    profile.experience,
    profile.education,
    profile.skills,
    profile.certifications,
    profile.languages
  ];
  const present = values.filter((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))).length;
  return Math.round((present / values.length) * 100);
}

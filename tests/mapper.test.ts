import { describe, expect, it } from "vitest";
import { calculateCompleteness, mapExtraction } from "../src/extractor/mapper.js";
import type { EndpointExtraction } from "../src/extractor/types.js";

function fixture(): EndpointExtraction {
  return {
    profileUrl: "https://www.linkedin.com/in/jane-doe/",
    warnings: [],
    voyagerPayloads: [
      {
        included: [
          {
            $type: "com.linkedin.voyager.identity.profile.Profile",
            entityUrn: "urn:li:fsd_profile:ACoViewer",
            publicIdentifier: "signed-in-viewer",
            firstName: "Wrong",
            lastName: "Person"
          },
          {
            $type: "com.linkedin.voyager.identity.profile.Profile",
            entityUrn: "urn:li:fsd_profile:ACoTarget",
            publicIdentifier: "jane-doe",
            firstName: "Jane",
            lastName: "Doe",
            headline: "Staff Software Engineer",
            geoLocationName: "Bengaluru, India",
            summary: "I build reliable distributed systems.",
            profilePicture: {
              rootUrl: "https://media.example/",
              artifacts: [{ width: 400, height: 400, fileIdentifyingUrlPathSegment: "large.jpg" }]
            }
          },
          {
            entityUrn: "urn:li:fsd_profilePosition:(ACoTarget,1)",
            title: "Staff Software Engineer",
            companyName: "Example Corp",
            dateRange: { start: { month: 1, year: 2022 } }
          },
          {
            $type: "com.linkedin.voyager.identity.profile.Education",
            entityUrn: "urn:li:fsd_profileEducation:(ACoTarget,2)",
            schoolName: "Example University",
            degreeName: "B.Tech"
          },
          { entityUrn: "urn:li:fsd_profileSkill:(ACoTarget,3)", name: "TypeScript" },
          {
            $type: "com.linkedin.voyager.identity.profile.Certification",
            entityUrn: "urn:li:fsd_profileCertification:(ACoTarget,4)",
            name: "Cloud Architect",
            authority: "Cloud Foundation"
          },
          {
            $type: "com.linkedin.voyager.identity.profile.Language",
            entityUrn: "urn:li:fsd_profileLanguage:(ACoTarget,5)",
            name: "English",
            proficiency: "Professional"
          },
          { entityUrn: "urn:li:fsd_profileSkill:(ACoViewer,6)", name: "Private Viewer Skill" }
        ]
      }
    ]
  };
}

describe("mapExtraction", () => {
  it("maps only the requested member from normalized Voyager JSON", () => {
    const result = mapExtraction(fixture());

    expect(result.profile).toMatchObject({
      name: "Jane Doe",
      headline: "Staff Software Engineer",
      location: "Bengaluru, India",
      profileImageUrl: "https://media.example/large.jpg",
      skills: ["TypeScript"]
    });
    expect(result.profile.experience[0]).toMatchObject({ title: "Staff Software Engineer", company: "Example Corp" });
    expect(result.profile.education[0]).toMatchObject({ school: "Example University", degree: "B.Tech" });
    expect(result.profile.certifications[0]?.name).toBe("Cloud Architect");
    expect(result.profile.languages[0]?.name).toBe("English");
    expect(result.profile.skills).not.toContain("Private Viewer Skill");
    expect(calculateCompleteness(result.profile)).toBe(100);
  });

  it("fails safely when no matching profile identity is returned", () => {
    const raw = fixture();
    raw.voyagerPayloads = [];
    expect(() => mapExtraction(raw)).toThrow(/no matching profile identity/i);
  });

  it("reports endpoint fields missing from the session response", () => {
    const raw = fixture();
    const included = (raw.voyagerPayloads[0] as { included: unknown[] }).included;
    (raw.voyagerPayloads[0] as { included: unknown[] }).included = included.slice(0, 2);
    const result = mapExtraction(raw);
    expect(result.warnings).toEqual(expect.arrayContaining(["experience was not available to the configured LinkedIn session"]));
  });
});

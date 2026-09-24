import { describe, expect, it } from "vitest";
import { connectionOwner, parseConnectionPage } from "../../src/shared/connections";
import { dedupeKey } from "../../src/shared/normalize";

const owner = "urn:li:fs_miniProfile:owner1234";
function page() {
  return { data: { elements: ["urn:li:connection:1"], paging: { start: 0, count: 40, total: 1 } }, included: [
    { entityUrn: "urn:li:fsd_profile:unrelated", firstName: "Not", lastName: "Connected", publicIdentifier: "unrelated" },
    { entityUrn: "urn:li:fsd_profile:person1234", firstName: "Jane", lastName: "Doe", publicIdentifier: "jane-doe", headline: "Engineer" },
    { entityUrn: "urn:li:connection:1", connectedMember: "urn:li:fsd_profile:person1234", createdAt: 1700000000000 }
  ] };
}
describe("connections response contract", () => {
  it("resolves edges by URN rather than included order; does not invent relationships for unrelated profiles", () => {
    const result = parseConnectionPage(page(), owner, 0, 40);
    expect(result).toMatchObject({ done: true, nextStart: 1, leads: [{ full_name: "Jane Doe", connection_degree: "1st", connection_owner_urn: owner, connected_at: "2023-11-14T22:13:20.000Z", linkedin_url: "https://www.linkedin.com/in/jane-doe" }] });
    expect(result.leads).toHaveLength(1);
  });
  it("supports normalized starred relationships", () => {
    const raw = page();
    const conn = raw.included[2] as Record<string, unknown>;
    conn["*connectedMember"] = conn.connectedMember;
    delete conn.connectedMember;
    expect(parseConnectionPage(raw, owner, 0, 40).leads).toHaveLength(1);
  });
  it("fails loudly on schema drift, unresolved relationships, and inconsistent paging", () => {
    expect(() => parseConnectionPage({}, owner, 0, 40)).toThrow();
    const missing = page(); missing.included.pop();
    expect(() => parseConnectionPage(missing, owner, 0, 40)).toThrow();
    expect(() => parseConnectionPage(page(), owner, 40, 40)).toThrow();
    const empty = page(); empty.data.elements = [];
    expect(() => parseConnectionPage(empty, owner, 0, 40)).toThrow();
  });
  it("identifies the owner from the current-user response, never an arbitrary included profile", () => {
    expect(connectionOwner({ miniProfile: { entityUrn: owner } })).toBe(owner);
    expect(connectionOwner({ data: { "*miniProfile": owner }, included: [{ entityUrn: owner }] })).toBe(owner);
    expect(() => connectionOwner({ included: [{ entityUrn: owner }] })).toThrow();
  });
  it("keeps relationship dedupe separate for each owner and ordinary profile captures", () => {
    const lead = parseConnectionPage(page(), owner, 0, 40).leads[0];
    expect(dedupeKey(lead)).not.toBe(dedupeKey({ ...lead, connection_owner_urn: "urn:li:member:other1234" }));
    expect(dedupeKey(lead)).not.toBe(dedupeKey({ ...lead, connection_owner_urn: undefined }));
  });
});

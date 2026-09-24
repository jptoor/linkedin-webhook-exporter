import { describe, expect, it } from "vitest";
import { parseConnectionsCsv } from "../../src/shared/connections";
import { dedupeKey } from "../../src/shared/normalize";
const owner = "https://www.linkedin.com/in/owner";
const header = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";
const row = 'Jane,Doe,https://www.linkedin.com/in/jane,private@example.com,"Acme, Inc",VP,23 Sep 2020';
describe("official connection archives", () => {
  it("supports BOM, preamble, CRLF, commas and quotes without retaining extra columns", () => {
    const leads = parseConnectionsCsv('\uFEFFNotes:\r\nYour "Connections" export\r\n\r\n' + header + '\r\n' + row, owner);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ full_name: "Jane Doe", company_name: "Acme, Inc", connected_at: "2020-09-23", connection_source: "archive", connection_owner_url: owner, connection_degree: "1st" });
    expect(leads[0].connection_owner_urn).toBeUndefined();
    expect(JSON.stringify(leads)).not.toContain("private@example.com");
  });
  it("supports multiline and escaped quoted fields", () => {
    expect(parseConnectionsCsv(header + '\n' + row.replace('"Acme, Inc"', '"Acme ""Labs""\nInc"'), owner)[0].company_name).toContain('Acme "Labs"');
  });
  it("rejects non-export files, malformed rows, duplicate identities, missing URLs and ambiguous dates", () => {
    for (const text of ["not a CSV", header, header + '\nJane,Doe', header + '\n' + row + '\n' + row, header + '\n' + row.replace('https://www.linkedin.com/in/jane', ''), header + '\n' + row.replace('23 Sep 2020', '09/10/2020'), header + '\n' + row.replace('23 Sep 2020', '31 Feb 2020')]) expect(() => parseConnectionsCsv(text, owner)).toThrow();
  });
  it("requires an owner and separates the same contact across owners", () => {
    expect(() => parseConnectionsCsv(header + '\n' + row, "https://evil.example/in/me")).toThrow();
    const lead = parseConnectionsCsv(header + '\n' + row, owner)[0];
    expect(dedupeKey(lead)).not.toBe(dedupeKey({ ...lead, connection_owner_url: "https://www.linkedin.com/in/other" }));
  });
});

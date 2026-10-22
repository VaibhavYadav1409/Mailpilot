import { describe, expect, it } from "vitest";
import { explainGoogleTokenError, explainMicrosoftTokenError } from "../src/services/tokenErrors";

const ms = (error: string, code: number) => JSON.stringify({ error, error_description: `AADSTS${code}: something.`, error_codes: [code] });

describe("why a mail account sign-in failed", () => {
  it("password changed / expired / consent removed = needs reconnect, with a plain reason", () => {
    const a = explainMicrosoftTokenError(400, ms("invalid_grant", 50173));
    expect(a.kind).toBe("RECONNECT");
    expect(a.reason).toBe("Microsoft says the mailbox password was changed or reset (or the account was locked) (AADSTS50173).");
    expect(explainMicrosoftTokenError(400, ms("invalid_grant", 700082)).reason).toMatch(/expired after a long time without use/);
    expect(explainMicrosoftTokenError(400, ms("invalid_grant", 65001)).kind).toBe("RECONNECT");
  });
  it("MailPilot's own app secret problem never disconnects mailboxes", () => {
    const a = explainMicrosoftTokenError(401, ms("invalid_client", 7000222));
    expect(a.kind).toBe("APP_CONFIG");
    expect(a.reason).toMatch(/app secret/);
  });
  it("temporary Microsoft errors are not a disconnect (they used to be, because the body contained AADSTS)", () => {
    expect(explainMicrosoftTokenError(503, "Service Unavailable").kind).toBe("TRANSIENT");
    expect(explainMicrosoftTokenError(400, ms("temporarily_unavailable", 50196)).kind).toBe("TRANSIENT");
    expect(explainMicrosoftTokenError(400, ms("invalid_request", 90009)).kind).toBe("TRANSIENT");
  });
  it("Google", () => {
    expect(explainGoogleTokenError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." })).kind).toBe("RECONNECT");
    expect(explainGoogleTokenError(401, JSON.stringify({ error: "invalid_client" })).kind).toBe("APP_CONFIG");
    expect(explainGoogleTokenError(500, "oops").kind).toBe("TRANSIENT");
  });
});

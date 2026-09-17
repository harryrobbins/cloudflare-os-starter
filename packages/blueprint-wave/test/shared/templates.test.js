import { describe, expect, it } from "vitest";
import { TEMPLATES, TEMPLATE_LIMITS, getTemplate, templateOperation } from "../../src/shared/templates.js";
import { LIMITS, cleanBlipOp, isTemplateId, previewOf, storedBytes } from "../../src/shared/protocol.js";
import { parseMarkdown } from "../../src/shared/markdown.js";
import { isValidOrderKey } from "../../src/shared/order.js";

describe("templates", () => {
  it("offers the five templates in the planned order", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["blank", "decision", "design_review", "retrospective", "incident_review"]);
    expect(TEMPLATES.map((t) => t.title)).toEqual(["Blank", "Decision", "Design review", "Retrospective", "Incident review"]);
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });

  it("keeps every template within the server's limits", () => {
    const ids = new Set();
    for (const t of TEMPLATES) {
      expect(isTemplateId(t.id)).toBe(true);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.title.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.titleChars);
      expect(t.description.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.descriptionChars);
      expect(t.description).not.toContain("\n");
      expect(t.brief.length).toBeGreaterThan(0);
      expect(t.brief.length).toBeLessThanOrEqual(LIMITS.textChars);
      expect(t.roots.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.roots);
      expect(1 + t.roots.length).toBeLessThanOrEqual(LIMITS.blips);
      for (const root of t.roots) {
        expect(root.text.length).toBeGreaterThan(0);
        expect(root.text.length).toBeLessThanOrEqual(LIMITS.textChars);
        expect(parseMarkdown(root.text).length).toBeGreaterThan(0);
        expect(previewOf(root.text).length).toBeLessThanOrEqual(LIMITS.preview);
      }
      expect(parseMarkdown(t.brief)[0]).toMatchObject({ type: "heading", level: 1 });
      // The whole template request stays far below one storage value and one RPC message.
      expect(storedBytes(t)).toBeLessThan(32 * 1024);
    }
  });

  it("looks templates up by id", () => {
    expect(getTemplate("decision")?.title).toBe("Decision");
    expect(getTemplate("nope")).toBeNull();
    expect(getTemplate(undefined)).toBeNull();
  });

  it("builds a valid applyOperation body with fresh ids and ordered keys", () => {
    let n = 0;
    const newId = () => "b_" + (++n).toString(16).padStart(12, "0");
    const op = templateOperation("incident_review", { newId });
    expect(op.structure).toEqual({ template: "incident_review" });
    expect(op.blipOps).toHaveLength(5);
    expect(op.blipOps[0]).toMatchObject({ op: "create", kind: "brief", parentId: null });
    expect(op.blipOps.slice(1).every((b) => b.kind === "note" && b.parentId === null)).toBe(true);
    const ids = op.blipOps.map((b) => b.blipId);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = op.blipOps.map((b) => b.order);
    expect(orders.every(isValidOrderKey)).toBe(true);
    expect([...orders].sort()).toEqual(orders);
    for (const raw of op.blipOps) {
      const cleaned = cleanBlipOp(raw);
      expect(cleaned.ok).toBe(true);
      expect(cleaned.op).toEqual(raw);
    }
    expect(templateOperation("blank").blipOps).toHaveLength(1);
    expect(templateOperation("missing")).toBeNull();
  });

  it("generates real blip ids by default", () => {
    const op = templateOperation("decision");
    expect(op.blipOps.every((b) => /^b_[0-9a-f]{12}$/.test(b.blipId))).toBe(true);
  });
});

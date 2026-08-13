// Unit tests for the standard template's planning-probe helpers
// (src/templates/standard/probe.ts). The helpers are plain functions so the
// generated plan.mts stays thin and the grill→spec→tickets state machine is
// testable.
//
// The test lives outside src/templates/ so it is never copied into
// scaffolded projects or dist/templates.

import { describe, expect, it } from "vitest";
import {
  AGENT_COMMENT_MARKER,
  probePlanningPhase,
  type PlanningPhase,
} from "./templates/standard/probe.js";

const agentComment = `${AGENT_COMMENT_MARKER} anything`;

describe("probePlanningPhase", () => {
  it("grills a discussion task that was never grilled", () => {
    expect(
      probePlanningPhase({ labels: [], comments: [] }),
    ).toBe<PlanningPhase>("grill");
  });

  it("grills again when the latest comment is human", () => {
    expect(
      probePlanningPhase({
        labels: [],
        comments: [agentComment, "human answer"],
      }),
    ).toBe<PlanningPhase>("grill");
  });

  it("waits when the latest comment is the agent and the task is not aligned", () => {
    expect(
      probePlanningPhase({ labels: [], comments: [agentComment] }),
    ).toBe<PlanningPhase>("wait");
  });

  it("specs an aligned task that has no spec yet", () => {
    expect(
      probePlanningPhase({ labels: ["aligned"], comments: [agentComment] }),
    ).toBe<PlanningPhase>("spec");
  });

  it("tickets a specced task that is not planned", () => {
    expect(
      probePlanningPhase({
        labels: ["aligned", "specced"],
        comments: [agentComment, agentComment],
      }),
    ).toBe<PlanningPhase>("tickets");
  });

  it("never picks up a planned task (defensive: the list excludes it)", () => {
    expect(
      probePlanningPhase({
        labels: ["aligned", "specced", "planned"],
        comments: [agentComment],
      }),
    ).toBe<PlanningPhase>("wait");
  });

  it("only treats comments starting with the marker as agent comments", () => {
    expect(
      probePlanningPhase({
        labels: [],
        comments: [`someone wrote ${AGENT_COMMENT_MARKER} in the middle`],
      }),
    ).toBe<PlanningPhase>("grill");
  });
});

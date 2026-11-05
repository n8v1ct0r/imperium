// The level table test (docs/policy.md section 1): 3 levels x 3 action kinds x 3 constraint
// states x 2 pause states, end to end through the control plane (intake, decision, grant,
// executor, reports). No cell may dispatch a consequential action without an authz.approved
// entry from a human, and no cell may execute anything but pause_hold while paused.
//
// Expected results come from the spec formulas written out here, not from levels.ts:
//   blocked          = consequential && level === monitor_only
//   requiresApproval = consequential || level === approve_every_action && !contingency
//                      || an approval_override constraint is touched
// The constraint in the override and hard states is a time window that has not started yet
// (the action starts before it), which P1 does not count as an effect, so a routine action
// stays routine.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionParams, AutonomyLevel, Constraint } from "@imperium/protocol";
import { at } from "../testing/source-messages.ts";
import { bound, policyRig, type PolicyRig } from "../testing/policy-rig.ts";
import { blockedReason, effectivePermission, requiresApproval } from "./levels.ts";

const LEVELS: readonly AutonomyLevel[] = [
  "monitor_only",
  "approve_consequential_only",
  "approve_every_action",
];
const KINDS = ["routine", "consequential", "contingency"] as const;
const CONSTRAINT_STATES = ["clear", "approval_override", "hard"] as const;

type Kind = (typeof KINDS)[number];
type ConstraintState = (typeof CONSTRAINT_STATES)[number];

const PARAMS: Record<Exclude<Kind, "contingency">, ActionParams> = {
  routine: { actionType: "route.minor_adjust", waypoints: [at(2_000)] },
  consequential: { actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 30 },
};

function constraintsFor(state: ConstraintState, t: number): Constraint[] {
  if (state === "clear") return [];
  return [{ id: "tw-1", kind: "time_window", start: t + 100_000, end: t + 1_000_000, mode: state }];
}

function setup(level: AutonomyLevel, cs: ConstraintState, paused: boolean): PolicyRig {
  const r = policyRig();
  assert.equal(r.intent(constraintsFor(cs, r.t)).status, "applied");
  const lv = r.command({ type: "group.set_level", commandId: "c-level", groupId: "grp-1", level });
  assert.equal(lv.status, "applied");
  if (paused)
    assert.equal(r.command({ type: "control.pause_all", commandId: "c-pause" }).status, "applied");
  return r;
}

/** Log invariants every cell must keep. */
function invariants(r: PolicyRig): void {
  let paused = false;
  const approved = new Set<string>();
  const grantOf = new Map<string, string>();
  for (const e of r.entries()) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "control.paused") paused = true;
    if (e.type === "control.resumed") paused = false;
    if (e.type === "authz.approved") {
      assert.ok(["human", "scripted_operator"].includes(e.actor.kind));
      approved.add(`${String(p.requestId)}:${String(p.revision)}`);
    }
    if (e.type === "grant.minted")
      grantOf.set(String(p.grantId), `${String(p.requestId)}:${String(p.revision)}`);
    if (e.type === "action.dispatched" || e.type === "action.executed") {
      assert.equal(paused, false, `${e.type} while paused`);
      assert.ok(approved.has(grantOf.get(String(p.grantId)) ?? ""), `${e.type} without approval`);
    }
  }
}

describe("level table: 3 levels x 3 kinds x 3 constraint states x 2 pause states", () => {
  for (const level of LEVELS) {
    for (const kind of KINDS) {
      for (const cs of CONSTRAINT_STATES) {
        for (const paused of [false, true]) {
          test(`${level} / ${kind} / ${cs} / ${paused ? "paused" : "running"}`, () => {
            const r = setup(level, cs, paused);
            const consequential = kind === "consequential";
            const override = cs === "approval_override";
            const blocked = consequential && level === "monitor_only";
            const needs =
              consequential ||
              (level === "approve_every_action" && kind !== "contingency") ||
              override;

            if (kind === "contingency") {
              const before = r.headSeq();
              r.report({
                assetId: "ae-001",
                actionType: "contingency.energy_return",
                proposalId: null,
                grantId: null,
                phase: "started",
                outcome: { code: "started", text: "Energy return" },
              });
              r.report({
                assetId: "ae-001",
                actionType: "contingency.pause_hold",
                proposalId: null,
                grantId: null,
                phase: "started",
                outcome: { code: "held", text: "Held" },
              });
              assert.deepEqual(
                r.since(before).map((e) => e.type),
                [
                  paused ? "action.unauthorized_report" : "action.contingency_reported",
                  "action.contingency_reported",
                ],
                "contingencies run without approval, but only pause_hold while paused",
              );
              invariants(r);
              return;
            }

            // A report of the action run with no grant (the footprint is unknown to policy,
            // so the expectation ignores the constraint; P26 covers the real effect).
            const direct = r.headSeq();
            r.report({
              assetId: "ae-001",
              actionType: PARAMS[kind].actionType,
              proposalId: null,
              grantId: null,
              phase: "completed",
              outcome: { code: "done", text: "Done" },
            });
            const unauthorizedDirect = paused || consequential || level === "approve_every_action";
            assert.deepEqual(
              r.since(direct).map((e) => e.type),
              [unauthorizedDirect ? "action.unauthorized_report" : "action.routine_reported"],
            );

            // The same action proposed.
            const before = r.headSeq();
            r.proposeParams(PARAMS[kind]);
            const intake = r.since(before).map((e) => e.type);
            const req = r.request();
            if (blocked || cs === "hard") {
              assert.deepEqual(intake, ["authz.requested", "authz.rejected_by_policy"]);
              assert.equal(req.status, "rejected_by_policy");
              const rejection = r.since(before)[1]!.payload as { reason: string };
              assert.equal(rejection.reason, blocked ? "level_monitor_only" : "hard_constraint");
              invariants(r);
              return;
            }
            assert.deepEqual(intake, ["authz.requested"]);
            assert.equal(req.status, "pending");
            assert.deepEqual(req.constraintsTouched, override ? ["tw-1"] : []);
            assert.equal(
              requiresApproval({
                kind,
                level,
                permission: null,
                touchesApprovalOverride: override,
              }),
              needs,
            );

            const decided = r.headSeq();
            const res = r.command({ type: "authz.approve", commandId: "c-approve", ...bound(req) });
            const after = r.since(decided).map((e) => e.type);
            if (paused) {
              assert.deepEqual(res, {
                status: "rejected",
                commandId: "c-approve",
                reason: "paused",
              });
              assert.deepEqual(after, ["command.rejected"]);
              assert.equal(r.request().status, "pending");
            } else {
              assert.deepEqual(res, { status: "applied", commandId: "c-approve" });
              assert.deepEqual(after, ["authz.approved", "grant.minted", "action.dispatched"]);
              const execute = r.sent.filter((m) => m.type === "action.execute");
              assert.equal(execute.length, 1, "the source got exactly 1 action.execute");
            }
            invariants(r);
          });
        }
      }
    }
  }
});

describe("level matrix functions", () => {
  test("blocked and requiresApproval follow section 1", () => {
    for (const level of LEVELS) {
      for (const kind of ["routine", "consequential", "contingency"] as const) {
        for (const permission of [null, "requires_approval", "not_permitted"] as const) {
          const input = { kind, level, permission, touchesApprovalOverride: false };
          const blocked =
            (kind === "consequential" && level === "monitor_only") ||
            permission === "not_permitted";
          assert.equal(blockedReason(input) !== null, blocked);
          assert.equal(
            requiresApproval(input),
            kind === "consequential" ||
              (level === "approve_every_action" && kind !== "contingency") ||
              permission === "requires_approval",
          );
          assert.equal(requiresApproval({ ...input, touchesApprovalOverride: true }), true);
        }
      }
    }
  });

  test("permissions only tighten: not_permitted wins, the shortest limit wins", () => {
    const base = {
      objective: { kind: "survey" as const, text: "x" },
      area: [],
      constraints: [],
      contingencies: { lostLink: "hold" as const, lowEnergy: "return_home" as const },
    };
    const intents = [
      {
        ...base,
        intentId: "in-1",
        groupIds: ["grp-1"],
        permissions: [
          {
            actionType: "data.release" as const,
            rule: "requires_approval" as const,
            timeLimitS: 120,
          },
        ],
      },
      {
        ...base,
        intentId: "in-2",
        groupIds: ["grp-1"],
        permissions: [
          { actionType: "data.release" as const, rule: "not_permitted" as const, timeLimitS: 60 },
        ],
      },
      {
        ...base,
        intentId: "in-3",
        groupIds: ["grp-2"],
        permissions: [
          {
            actionType: "data.release" as const,
            rule: "requires_approval" as const,
            timeLimitS: 30,
          },
        ],
      },
    ];
    assert.deepEqual(effectivePermission(intents, "grp-1", "data.release"), {
      rule: "not_permitted",
      timeLimitS: 60,
    });
    assert.deepEqual(effectivePermission(intents, "grp-3", "data.release"), {
      rule: null,
      timeLimitS: null,
    });
  });
});

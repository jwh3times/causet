/**
 * Declared interactive rewrite actions (ADR-0035).
 *
 * Git's sequencer offers `reword`, `edit`, `squash`, and `fixup`, and handing
 * the four to it would let whatever it happens to do decide what happens to
 * logical identity. ADR-0011 set out to stop exactly that, so here each action
 * is a *declared plan action with its own identity rule*, checked before
 * anything runs and covered by the plan fingerprint.
 *
 * The four are not variations of one operation:
 *
 * - `reword` changes a message and nothing else, so the identity is preserved
 *   by construction and the trailer is reapplied by the operation rather than
 *   left in a buffer for someone to edit around.
 * - `edit` changes what the identity *contains* while keeping it, which is the
 *   one local operation that can make a proof in another clone wrong. It
 *   publishes an amendment so coverage can stop vouching for content nobody
 *   reviewed.
 * - `squash` and `fixup` absorb one commit into another, reusing the landing
 *   absorption model: exactly one surviving trailer, and the absorbed
 *   identities named in a record rather than in extra trailers.
 *
 * This module owns the declaration, its validation, and the order the result
 * implies. It mints no identity, touches no repository, and decides nothing
 * about coverage.
 */
import { CliError } from "./errors.js";

/** The declared actions, in the order a plan reports them. */
export const INTERACTIVE_ACTIONS = Object.freeze(["reword", "edit", "squash", "fixup"]);

/** The two that absorb a commit into another, and so name a target. */
const ABSORBING = new Set(["squash", "fixup"]);

/**
 * Actions that still produce a commit of their own.
 *
 * `reword` and `edit` replay their change like any other and then do something
 * to the result, so they stay in the replay queue. `squash` and `fixup` do not:
 * their content lands inside the surviving commit, which is exactly what makes
 * the surviving identity the only one on the commit.
 */
export const SURVIVING_ACTIONS = Object.freeze(new Set(["replay", "reword", "edit"]));

/** True when this action melds its change into another commit. */
export function isAbsorbing(action) {
  return ABSORBING.has(action);
}

/**
 * Parse one `--squash`/`--fixup` value into its subject and target.
 *
 * The form is `<subject>=<target>`, split on the first `=` so a revision
 * expression containing one later is not mangled. `reword` and `edit` name only
 * a subject, and a value that carries a `=` anyway is refused rather than
 * silently ignored — it almost certainly means the caller expected it to do
 * something.
 */
function parseDeclaration(action, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new CliError(`--${action} requires a commit.`, {
      code: "usage-missing-argument",
      details: ABSORBING.has(action)
        ? `Use --${action} <subject>=<target>.`
        : `Use --${action} <commit>.`,
    });
  }
  const separator = text.indexOf("=");
  if (!ABSORBING.has(action)) {
    if (separator !== -1) {
      throw new CliError(`--${action} names one commit, not a pair.`, {
        code: "usage-invalid-option-value",
        details: `Use --${action} <commit>. Only --squash and --fixup take <subject>=<target>.`,
      });
    }
    return { action, subject: text, target: null };
  }
  if (separator <= 0 || separator === text.length - 1) {
    throw new CliError(`--${action} needs both a subject and a target.`, {
      code: "usage-invalid-option-value",
      details:
        `Use --${action} <subject>=<target>. The target is the commit that survives and keeps its identity.`,
    });
  }
  return {
    action,
    subject: text.slice(0, separator).trim(),
    target: text.slice(separator + 1).trim(),
  };
}

/** Every `--reword/--edit/--squash/--fixup` the caller gave, as declarations. */
export function declaredInteractiveActions(options = {}) {
  return INTERACTIVE_ACTIONS.flatMap((action) => {
    const values = options[action];
    if (values === undefined || values === null) return [];
    return (Array.isArray(values) ? values : [values]).map((value) =>
      parseDeclaration(action, value),
    );
  });
}

function refuse(message, details) {
  return new CliError(message, { code: "unsupported-range", details });
}

/**
 * Resolve declarations against the plan's own changes, refusing every shape the
 * accepted contract does not admit.
 *
 * `resolve` turns a caller's revision expression into a commit id; it is passed
 * in rather than imported so this module stays free of repository reads and so
 * the plan resolves every expression through the session it already opened.
 *
 * The rules, and why each one exists:
 *
 * - **Every subject and target must be a replayed change of this range.** An
 *   action on a commit that is omitted as already covered, or that is outside
 *   the range entirely, would describe work this operation is not doing.
 * - **One action per commit.** Two declarations for the same commit have no
 *   defined composition, and picking one silently is the implicit behavior this
 *   contract exists to remove.
 * - **A target must precede its subject.** Absorption melds a commit into one
 *   already applied; the reverse would need the subject's content before it
 *   exists.
 * - **A target must itself survive.** Absorbing into a commit that is being
 *   absorbed elsewhere makes the surviving identity depend on the order the
 *   chain is resolved in, which is the squash-message trap in another form.
 * - **A recreated merge is never a subject or a target** (ADR-0034 and
 *   ADR-0035 together): a merge claims nothing, so there is no identity to
 *   reword, amend, or absorb.
 */
export function resolveInteractiveProgram(declarations, plan, resolve) {
  if (declarations.length === 0) {
    return { actions: [], byCommit: new Map(), absorbedInto: new Map() };
  }

  const replayable = new Map(
    plan.changes
      .filter((change) => change.action === "replay")
      .map((change, index) => [change.commit, { ...change, order: index }]),
  );
  const mergeCommits = new Set(plan.constraints.mergeCommits ?? []);
  const rangeOrder = new Map(
    plan.changes.map((change, index) => [change.commit, index]),
  );

  const named = (expression, role, action) => {
    let commit;
    try {
      commit = resolve(expression);
    } catch {
      throw refuse(
        `--${action} names ${expression}, which does not resolve to a commit.`,
        "Name a commit inside the rebased range.",
      );
    }
    if (mergeCommits.has(commit)) {
      throw refuse(
        `--${action} names the merge ${commit.slice(0, 12)} as its ${role}.`,
        "A recreated merge claims nothing, so it has no identity to reword, amend, or absorb (ADR-0034).",
      );
    }
    if (!replayable.has(commit)) {
      throw refuse(
        `--${action} names ${commit.slice(0, 12)} as its ${role}, which this rebase does not replay.`,
        rangeOrder.has(commit)
          ? "The change is already covered, so the rebase omits it and there is nothing to rewrite."
          : "Name a commit inside the rebased range.",
      );
    }
    return commit;
  };

  const actions = [];
  const byCommit = new Map();
  for (const declaration of declarations) {
    const subject = named(declaration.subject, "subject", declaration.action);
    if (byCommit.has(subject)) {
      throw refuse(
        `${subject.slice(0, 12)} is named by both --${byCommit.get(subject).action} and --${declaration.action}.`,
        "Declare one action per commit; two have no defined composition.",
      );
    }
    const target = declaration.target === null
      ? null
      : named(declaration.target, "target", declaration.action);
    if (target !== null) {
      if (target === subject) {
        throw refuse(
          `--${declaration.action} would absorb ${subject.slice(0, 12)} into itself.`,
          "Name a different target; the target is the commit that survives.",
        );
      }
      if (rangeOrder.get(target) > rangeOrder.get(subject)) {
        throw refuse(
          `--${declaration.action} names a target that comes after its subject.`,
          `${target.slice(0, 12)} is replayed after ${subject.slice(0, 12)}. Absorption melds a commit into one that has already been applied.`,
        );
      }
    }
    const resolved = { action: declaration.action, commit: subject, target };
    actions.push(resolved);
    byCommit.set(subject, resolved);
  }

  // Checked once every action is known, because a chain can be declared in
  // either order and neither declaration is wrong on its own.
  for (const action of actions) {
    if (action.target === null) continue;
    const targetAction = byCommit.get(action.target);
    if (targetAction && ABSORBING.has(targetAction.action)) {
      throw refuse(
        `--${action.action} absorbs into ${action.target.slice(0, 12)}, which is itself absorbed into ${targetAction.target.slice(0, 12)}.`,
        "Absorb into a surviving commit. A chain would make the surviving identity depend on the order it is resolved in.",
      );
    }
  }

  // Subjects grouped under the commit that survives them, in range order, which
  // is the order the rewrite applies them.
  const absorbedInto = new Map();
  for (const action of [...actions].sort(
    (left, right) => rangeOrder.get(left.commit) - rangeOrder.get(right.commit),
  )) {
    if (action.target === null) continue;
    absorbedInto.set(action.target, [
      ...(absorbedInto.get(action.target) ?? []),
      action,
    ]);
  }

  return {
    actions: actions.sort(
      (left, right) => rangeOrder.get(left.commit) - rangeOrder.get(right.commit),
    ),
    byCommit,
    absorbedInto,
  };
}

/**
 * The message a `reword` commits, and the check that it is still the same
 * change.
 *
 * The trailer is composed here rather than left to an editor: the caller's text
 * is taken verbatim, every `Change-Id` line it carries is stripped, and the
 * original identity is appended exactly once. A caller who wants a *different*
 * identity uses `--fork`, which already records `Derived-From`; rewording is
 * not a way to get one by accident.
 */
export function rewordedMessage(text, changeId) {
  const lines = String(text ?? "").split(/\r?\n/);
  // A trailer the caller wrote themselves is refused, not quietly dropped. It
  // is only ever one of two things: a restatement of the identity the operation
  // is about to append anyway, or an attempt to change identity by editing
  // prose — and the second is exactly what `--fork` exists for. Stripping it
  // silently would make rewording a way to get a new identity by accident, or
  // to fail to get one and not be told.
  const declared = lines
    .map((line) => line.match(/^Change-Id:\s*(.+?)\s*$/i)?.[1])
    .filter(Boolean);
  if (declared.some((value) => value !== changeId)) {
    throw new CliError(
      `A reworded message cannot declare a different identity than ${changeId}.`,
      {
        code: "identity-not-preserved",
        details:
          "Leave the Change-Id out; the operation appends the original. " +
          "Use --fork if you intend a different logical change.",
      },
    );
  }
  const body = lines
    .filter((line) => !/^Change-Id:\s*/i.test(line))
    .join("\n")
    .trimEnd();
  if (!body.trim()) {
    throw new CliError("A reworded message cannot be empty.", {
      code: "usage-invalid-option-value",
      details: "Supply the new message with: vlab rebase --continue -m \"<message>\"",
    });
  }
  return `${body}\n\nChange-Id: ${changeId}\n`;
}

/**
 * The surviving message of a `squash` or a `fixup`.
 *
 * Git's sequencer concatenates the messages it squashes, which would put
 * several `Change-Id` trailers in one commit and make the surviving identity
 * depend on parse order. The result here carries **exactly one** trailer, the
 * survivor's; the absorbed identities live in the absorption record instead.
 *
 * The only difference between the two actions is the absorbed prose: `squash`
 * keeps it under the surviving message, `fixup` discards it.
 */
export function absorbedMessage(survivingMessage, absorbed, changeId) {
  const strip = (text) =>
    String(text ?? "")
      .split(/\r?\n/)
      .filter((line) => !/^Change-Id:\s*/i.test(line))
      .join("\n")
      .trimEnd();
  const parts = [strip(survivingMessage)];
  for (const item of absorbed) {
    if (item.action !== "squash") continue;
    const prose = strip(item.message);
    if (prose) parts.push(prose);
  }
  return `${parts.filter(Boolean).join("\n\n")}\n\nChange-Id: ${changeId}\n`;
}

/**
 * The identity check every rewritten message passes before its commit is
 * created: exactly one `Change-Id`, and it is the one the action promised.
 *
 * A message that would lose or duplicate the trailer is refused rather than
 * committed and corrected, because the commit is the thing a peer reads.
 */
export function assertSingleIdentity(message, expected) {
  const found = String(message ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^Change-Id:\s*(.+?)\s*$/i)?.[1])
    .filter(Boolean);
  if (found.length !== 1 || found[0] !== expected) {
    throw new CliError(
      found.length === 1
        ? `The rewritten message carries identity ${found[0]}, not ${expected}.`
        : `The rewritten message carries ${found.length} Change-Id trailers; exactly one is required.`,
      {
        code: "identity-not-preserved",
        details:
          "Remove the Change-Id lines from the message you supply; the operation appends the right one. " +
          "Use --fork if you intend a different identity.",
      },
    );
  }
}

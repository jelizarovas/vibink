import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { containsRedaction, redactText } from "./redact.mjs";

export const BRAIN_CATEGORIES = Object.freeze([
  "design",
  "interaction",
  "project",
  "workflow",
]);

export const BRAIN_LIMITS = Object.freeze({
  learnings: 200,
  revisionsPerLearning: 25,
  listResults: 50,
  titleCharacters: 100,
  learningCharacters: 900,
  revisionBytes: 3072,
});

const DEFAULT_REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_LIST_LIMIT = 20;
const MAX_REVISION_SCAN = BRAIN_LIMITS.revisionsPerLearning * 4;
const WRITE_LOCK_FILE = ".vibink-write.lock";
const WRITE_LOCK_WAIT_MS = 5000;
const WRITE_LOCK_RETRY_MS = 25;
const LEARNING_ID_PATTERN = /^lrn-[a-f0-9]{32}$/;
const REVISION_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.json$/;
const RECORD_INPUT_KEYS = new Set([
  "category",
  "learning_id",
  "title",
  "learning",
  "owner_confirmed",
]);
const LIST_INPUT_KEYS = new Set(["category", "limit"]);
const CONFIGURATION_KEYS = new Set(["repositoryDirectory"]);
const STORED_RECORD_KEYS = new Set([
  "version",
  "id",
  "category",
  "title",
  "learning",
  "ownerConfirmed",
  "recordedAt",
  "revision",
  "supersedesRevision",
]);

const FORBIDDEN_PERSISTENT_CONTENT = Object.freeze([
  ["a URL", /\b(?:https?|wss?):\/\/\S+|\bwww\.\S+/i],
  ["a page or DOM dump", /\b(?:page\s+text|dom\s+(?:dump|snapshot|text)|document\s+html|innerhtml|outerhtml)\s*[:=]/i],
  ["a selector", /\b(?:queryselector|css\s+selector|xpath|data-testid|data-test-id)\b|(?:^|\s)(?:#(?![0-9a-f]{3,8}\b)[a-z][\w-]*|\.[a-z][\w-]*|\[[a-z][^\]\r\n]{0,100}\])(?=\s|$)/i],
  ["diagnostic output", /\b(?:console|network|diagnostic|stack)\s+(?:log|dump|trace|output)\s*[:=]|\bat\s+\S+\.(?:[cm]?js|jsx|tsx?):\d+:\d+/i],
  ["screenshot data", /\bdata:image\/[a-z0-9.+-]+;base64,|\b(?:screenshot|screen\s+capture)\s*[:=]\s*\S+/i],
  ["a voice transcript", /\b(?:voice|audio)\s+transcript\s*[:=]|\[\d{1,2}:\d{2}(?::\d{2})?\]\s+\S+/i],
  ["pairing data", /\b(?:pairing\s+)?(?:pin|code)\s*[:=]\s*[a-z0-9 -]{4,16}\b/i],
  ["person-specific context", /\b(?:customer|employee|applicant|buyer|co-?buyer)\s*[:=]\s*\S+/i],
  ["labeled person data", /\b(?:customer|employee|applicant|buyer)\s+(?:name|email|phone|address|identifier|id)\s*[:=]/i],
  ["a credential", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[pousr]|xox[baprs])[-_][a-z0-9_-]{16,}\b/i],
]);

function assertPlainObject(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object.`);
  }
}

function assertOnlyKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupported.length) {
    throw new Error(`${label} contains unsupported field(s): ${unsupported.join(", ")}.`);
  }
}

function safeCategory(value) {
  if (typeof value !== "string") {
    throw new Error(`Learning category must be one of: ${BRAIN_CATEGORIES.join(", ")}.`);
  }
  const category = value.trim().toLowerCase();
  if (!BRAIN_CATEGORIES.includes(category)) {
    throw new Error(`Learning category must be one of: ${BRAIN_CATEGORIES.join(", ")}.`);
  }
  return category;
}

function newLearningId() {
  return `lrn-${crypto.randomBytes(16).toString("hex")}`;
}

function safeLearningId(value) {
  if (typeof value !== "string" || !LEARNING_ID_PATTERN.test(value)) {
    throw new Error("Learning ID must be an opaque ID previously returned by the brain store.");
  }
  return value;
}

function safePersistentText(value, maxLength, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required and must be a string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} exceeds the ${maxLength}-character limit and was not truncated.`);
  }
  const redacted = redactText(value, Number.MAX_SAFE_INTEGER);
  if (redacted !== value || containsRedaction(redacted)) {
    throw new Error(`${label} would require normalization or redaction and was not saved.`);
  }
  for (const [description, pattern] of FORBIDDEN_PERSISTENT_CONTENT) {
    if (pattern.test(value)) {
      throw new Error(`${label} appears to contain ${description} and was not saved.`);
    }
  }
  return value;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function assertRealDirectory(directory, { allowMissing = false } = {}) {
  let directoryStats;
  try {
    directoryStats = await lstat(directory);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return false;
    throw error;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Vibink brain directories must be real local directories, not links.");
  }
  const canonical = await realpath(directory);
  if (comparablePath(canonical) !== comparablePath(directory)) {
    throw new Error("Vibink brain directories cannot escape through a link or junction.");
  }
  return true;
}

async function createOrValidateDirectory(directory) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertRealDirectory(directory);
}

async function directoryEntries(directory) {
  try {
    if (!await assertRealDirectory(directory, { allowMissing: true })) return [];
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function revisionEntries(entries) {
  return entries.filter(
    (entry) => entry.isFile() && REVISION_FILE_PATTERN.test(entry.name),
  );
}

async function learningDirectoryCount(rootDirectory) {
  let total = 0;
  for (const category of BRAIN_CATEGORIES) {
    const entries = await directoryEntries(path.join(rootDirectory, category));
    for (const entry of entries) {
      if (entry.isDirectory() && LEARNING_ID_PATTERN.test(entry.name)) {
        total += 1;
        if (total >= BRAIN_LIMITS.learnings) return total;
      }
    }
  }
  return total;
}

async function findLearningCategory(rootDirectory, id) {
  for (const category of BRAIN_CATEGORIES) {
    const entries = await directoryEntries(path.join(rootDirectory, category));
    if (entries.some(
      (entry) => entry.isDirectory() && entry.name === id && LEARNING_ID_PATTERN.test(entry.name),
    )) {
      return category;
    }
  }
  return null;
}

function isValidStoredRecord(record, { category, id, revision }) {
  try {
    assertOnlyKeys(record, STORED_RECORD_KEYS, "Stored revision");
    if (
      record.version !== 1
      || record.id !== id
      || record.category !== category
      || record.ownerConfirmed !== true
      || record.revision !== revision
      || !REVISION_FILE_PATTERN.test(record.revision)
      || typeof record.recordedAt !== "string"
      || !record.revision.startsWith(`${record.recordedAt.replace(/[:.]/g, "-")}-`)
      || (record.supersedesRevision !== null
        && (typeof record.supersedesRevision !== "string"
          || !REVISION_FILE_PATTERN.test(record.supersedesRevision)
          || record.supersedesRevision === record.revision))
      || !Number.isFinite(Date.parse(record.recordedAt))
    ) {
      return false;
    }
    safePersistentText(record.title, BRAIN_LIMITS.titleCharacters, "Learning title");
    safePersistentText(record.learning, BRAIN_LIMITS.learningCharacters, "Learning text");
    return true;
  } catch {
    return false;
  }
}

async function readValidRevision(learningDirectory, context, fileName) {
  const filePath = path.join(learningDirectory, fileName);
  let fileHandle;
  try {
    const fileStats = await lstat(filePath);
    if (
      !fileStats.isFile()
      || fileStats.isSymbolicLink()
      || fileStats.nlink > 1
      || fileStats.size <= 0
      || fileStats.size > BRAIN_LIMITS.revisionBytes
      || comparablePath(await realpath(filePath)) !== comparablePath(filePath)
    ) return null;
    fileHandle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const openedStats = await fileHandle.stat();
    if (
      !openedStats.isFile()
      || openedStats.nlink > 1
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
      || openedStats.size !== fileStats.size
    ) return null;
    const bounded = Buffer.allocUnsafe(BRAIN_LIMITS.revisionBytes + 1);
    let totalBytes = 0;
    while (totalBytes < bounded.length) {
      const { bytesRead } = await fileHandle.read(
        bounded,
        totalBytes,
        bounded.length - totalBytes,
        null,
      );
      if (!bytesRead) break;
      totalBytes += bytesRead;
    }
    const finalStats = await fileHandle.stat();
    if (
      totalBytes > BRAIN_LIMITS.revisionBytes
      || finalStats.dev !== openedStats.dev
      || finalStats.ino !== openedStats.ino
      || finalStats.size !== totalBytes
      || finalStats.mtimeMs !== openedStats.mtimeMs
    ) return null;
    const record = JSON.parse(bounded.subarray(0, totalBytes).toString("utf8"));
    return isValidStoredRecord(record, { ...context, revision: fileName }) ? record : null;
  } catch {
    return null;
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function latestRevision(learningDirectory, context) {
  const entries = revisionEntries(await directoryEntries(learningDirectory))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, MAX_REVISION_SCAN);
  for (const entry of entries) {
    const record = await readValidRevision(learningDirectory, context, entry.name);
    if (record) return record;
  }
  return null;
}

function revisionFileName(recordedAt) {
  const timestamp = recordedAt.replace(/[:.]/g, "-");
  return `${timestamp}-${crypto.randomBytes(4).toString("hex")}.json`;
}

function boundedListLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(BRAIN_LIMITS.listResults, Math.floor(number)));
}

function createMutationQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const current = tail.then(task, task);
    tail = current.catch(() => {});
    return current;
  };
}

async function acquireWriteLock(rootDirectory, signal) {
  const lockPath = path.join(rootDirectory, WRITE_LOCK_FILE);
  const deadline = Date.now() + WRITE_LOCK_WAIT_MS;

  while (true) {
    if (signal?.aborted) {
      throw new Error("Learning was not saved because the request was cancelled.");
    }
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      const heldStats = await lockHandle.stat();
      return async () => {
        let currentStats = null;
        try {
          currentStats = await lstat(lockPath);
        } catch {
          // A missing lock is already released.
        }
        await lockHandle.close().catch(() => {});
        if (
          currentStats?.isFile()
          && !currentStats.isSymbolicLink()
          && currentStats.nlink === 1
          && currentStats.dev === heldStats.dev
          && currentStats.ino === heldStats.ino
        ) {
          await unlink(lockPath).catch(() => {});
        }
      };
    } catch (error) {
      await lockHandle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        if (lockHandle) await unlink(lockPath).catch(() => {});
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Vibink brain is busy. If no save is active, stop every Vibink bridge before manually removing brain/.vibink-write.lock.",
        );
      }
      await delay(WRITE_LOCK_RETRY_MS, undefined, { signal }).catch((delayError) => {
        if (signal?.aborted || delayError?.name === "AbortError") {
          throw new Error("Learning was not saved because the request was cancelled.");
        }
        throw delayError;
      });
    }
  }
}

export function createBrainStore(options = {}) {
  assertOnlyKeys(options, CONFIGURATION_KEYS, "Brain store configuration");
  if (
    options.repositoryDirectory !== undefined
    && (typeof options.repositoryDirectory !== "string" || !options.repositoryDirectory)
  ) {
    throw new Error("repositoryDirectory must be a non-empty string when provided.");
  }
  const repositoryDirectory = path.resolve(
    options.repositoryDirectory || DEFAULT_REPOSITORY_DIRECTORY,
  );
  if (path.parse(repositoryDirectory).root === repositoryDirectory) {
    throw new Error("Vibink brain requires a specific non-root repository directory.");
  }
  const root = path.join(repositoryDirectory, "brain");
  let lastRecordedAtMs = 0;
  const runRecordMutation = createMutationQueue();

  async function prepareBrain({ create }) {
    await assertRealDirectory(repositoryDirectory);
    if (create) await createOrValidateDirectory(root);
    return assertRealDirectory(root, { allowMissing: !create });
  }

  return Object.freeze({
    rootDirectory: root,

    async record(input = {}, signal) {
      return runRecordMutation(async () => {
      assertOnlyKeys(input, RECORD_INPUT_KEYS, "Learning input");
      if (input.owner_confirmed !== true) {
        throw new Error("The owner must explicitly confirm this reusable learning before it is saved.");
      }

      const category = safeCategory(input.category);
      const title = safePersistentText(
        input.title,
        BRAIN_LIMITS.titleCharacters,
        "Learning title",
      );
      const learning = safePersistentText(
        input.learning,
        BRAIN_LIMITS.learningCharacters,
        "Learning text",
      );
      await prepareBrain({ create: true });
      const releaseWriteLock = await acquireWriteLock(root, signal);
      try {
      await prepareBrain({ create: true });
      const requestedId = input.learning_id === undefined
        ? null
        : safeLearningId(input.learning_id);
      const id = requestedId || newLearningId();
      const existingCategory = await findLearningCategory(root, id);

      if (requestedId && !existingCategory) {
        throw new Error("Learning ID is unknown; omit learning_id to create a new learning.");
      }
      if (existingCategory && existingCategory !== category) {
        throw new Error(`Learning ${id} already belongs to the ${existingCategory} category.`);
      }

      const categoryDirectory = path.join(root, category);
      const learningDirectory = path.join(categoryDirectory, id);
      const currentRevisions = revisionEntries(await directoryEntries(learningDirectory));
      if (!currentRevisions.length && await learningDirectoryCount(root) >= BRAIN_LIMITS.learnings) {
        throw new Error(`Vibink brain is limited to ${BRAIN_LIMITS.learnings} learnings.`);
      }
      if (currentRevisions.length >= BRAIN_LIMITS.revisionsPerLearning) {
        throw new Error(
          `Learning ${id} already has ${BRAIN_LIMITS.revisionsPerLearning} revisions; review it manually before adding more.`,
        );
      }

      const previous = await latestRevision(learningDirectory, { category, id });
      if (signal?.aborted) {
        throw new Error("Learning was not saved because the request was cancelled.");
      }
      await createOrValidateDirectory(categoryDirectory);
      await createOrValidateDirectory(learningDirectory);
      const previousRecordedAtMs = Date.parse(previous?.recordedAt || "");
      const recordedAtMs = Math.max(
        Date.now(),
        lastRecordedAtMs + 1,
        Number.isFinite(previousRecordedAtMs) ? previousRecordedAtMs + 1 : 0,
      );
      lastRecordedAtMs = recordedAtMs;
      const recordedAt = new Date(recordedAtMs).toISOString();
      const revision = revisionFileName(recordedAt);
      const record = {
        version: 1,
        id,
        category,
        title,
        learning,
        ownerConfirmed: true,
        recordedAt,
        revision,
        supersedesRevision: previous?.revision || null,
      };
      const serialized = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > BRAIN_LIMITS.revisionBytes) {
        throw new Error(
          `Learning revision exceeds the ${BRAIN_LIMITS.revisionBytes}-byte limit and was not truncated.`,
        );
      }
      if (signal?.aborted) {
        throw new Error("Learning was not saved because the request was cancelled.");
      }
      const revisionPath = path.join(learningDirectory, revision);
      let revisionHandle;
      try {
        revisionHandle = await open(revisionPath, "wx", 0o600);
        await revisionHandle.writeFile(serialized, "utf8");
        await revisionHandle.sync();
      } finally {
        await revisionHandle?.close().catch(() => {});
      }
      const storedStats = await lstat(revisionPath);
      const storedCanonical = await realpath(revisionPath);
      if (
        !storedStats.isFile()
        || storedStats.isSymbolicLink()
        || storedStats.nlink > 1
        || comparablePath(storedCanonical) !== comparablePath(revisionPath)
        || comparablePath(path.dirname(storedCanonical)) !== comparablePath(learningDirectory)
      ) {
        throw new Error("Vibink could not verify the saved learning revision safely.");
      }
      return record;
      } finally {
        await releaseWriteLock();
      }
      });
    },

    async list(input = {}) {
      assertOnlyKeys(input, LIST_INPUT_KEYS, "Brain list input");
      if (!await prepareBrain({ create: false })) return [];
      const categories = input.category
        ? [safeCategory(input.category)]
        : BRAIN_CATEGORIES;
      const safeLimit = boundedListLimit(input.limit ?? DEFAULT_LIST_LIMIT);
      const records = [];

      for (const currentCategory of categories) {
        const categoryDirectory = path.join(root, currentCategory);
        const learningDirectories = (await directoryEntries(categoryDirectory))
          .filter((entry) => entry.isDirectory() && LEARNING_ID_PATTERN.test(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name))
          .slice(0, BRAIN_LIMITS.learnings);
        for (const entry of learningDirectories) {
          const record = await latestRevision(
            path.join(categoryDirectory, entry.name),
            { category: currentCategory, id: entry.name },
          );
          if (record) records.push(record);
        }
      }

      return records
        .sort((left, right) => String(right.recordedAt).localeCompare(String(left.recordedAt)))
        .slice(0, safeLimit);
    },
  });
}

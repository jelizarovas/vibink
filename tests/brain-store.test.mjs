import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { BRAIN_LIMITS, createBrainStore } from "../bridge/brain-store.mjs";

async function temporaryStore(testContext) {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), "vibink-brain-"));
  testContext.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  return {
    repositoryDirectory,
    store: createBrainStore({ repositoryDirectory }),
  };
}

const confirmedLearning = Object.freeze({
  category: "design",
  title: "Compact controls",
  learning: "Prefer compact icon controls when their purpose remains accessible.",
  owner_confirmed: true,
});

test("keeps the transient brain write lock out of version control", async () => {
  const ignoreSource = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignoreSource, /^brain\/\.vibink-write\.lock$/m);
});

test("records only under the fixed repository brain with an opaque ID", async (t) => {
  const { repositoryDirectory, store } = await temporaryStore(t);
  const record = await store.record(confirmedLearning);

  assert.equal(store.rootDirectory, path.join(repositoryDirectory, "brain"));
  assert.match(record.id, /^lrn-[a-f0-9]{32}$/);
  assert.equal(record.title.includes(record.id), false);
  assert.equal(record.supersedesRevision, null);

  const files = await readdir(path.join(store.rootDirectory, "design", record.id));
  assert.deepEqual(files, [record.revision]);
  const saved = JSON.parse(await readFile(
    path.join(store.rootDirectory, "design", record.id, record.revision),
    "utf8",
  ));
  assert.deepEqual(saved, record);
});

test("requires literal owner confirmation and rejects arbitrary input fields", async (t) => {
  const { store } = await temporaryStore(t);

  await assert.rejects(
    store.record({ ...confirmedLearning, owner_confirmed: false }),
    /owner must explicitly confirm/i,
  );
  await assert.rejects(
    store.record({ ...confirmedLearning, path: "../outside" }),
    /unsupported field.*path/i,
  );
  await assert.rejects(
    store.list({ path: "../outside" }),
    /unsupported field.*path/i,
  );
  assert.throws(
    () => createBrainStore({ rootDirectory: "C:\\arbitrary\\brain" }),
    /unsupported field.*rootDirectory/i,
  );
});

test("rejects a brain root that is a link or junction", async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), "vibink-brain-link-"));
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "vibink-brain-outside-"));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  try {
    await symlink(outsideDirectory, path.join(repositoryDirectory, "brain"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) return;
    throw error;
  }
  const store = createBrainStore({ repositoryDirectory });
  await assert.rejects(store.record(confirmedLearning), /link|junction/i);
  await assert.rejects(store.list(), /link|junction/i);
});

test("rejects a linked category before creating a learning beneath it", async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), "vibink-brain-category-link-"));
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "vibink-brain-category-outside-"));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await mkdir(path.join(repositoryDirectory, "brain"));
  try {
    await symlink(outsideDirectory, path.join(repositoryDirectory, "brain", "design"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) return;
    throw error;
  }

  const store = createBrainStore({ repositoryDirectory });
  await assert.rejects(store.record(confirmedLearning), /link|junction/i);
  assert.deepEqual(await readdir(outsideDirectory), []);
});

test("allows only fixed categories and server-issued opaque learning IDs", async (t) => {
  const { store } = await temporaryStore(t);

  await assert.rejects(
    store.record({ ...confirmedLearning, category: "../design" }),
    /category must be one of/i,
  );
  await assert.rejects(
    store.record({ ...confirmedLearning, learning_id: "compact-controls" }),
    /opaque ID/i,
  );
  await assert.rejects(
    store.record({
      ...confirmedLearning,
      learning_id: "lrn-00000000000000000000000000000000",
    }),
    /unknown/i,
  );
});

test("rejects redaction, normalization, truncation, and oversized JSON", async (t) => {
  const { store } = await temporaryStore(t);

  await assert.rejects(
    store.record({ ...confirmedLearning, learning: "Email jane@example.com for approval." }),
    /redaction/i,
  );
  await assert.rejects(
    store.record({ ...confirmedLearning, learning: " Leading whitespace is not normalized." }),
    /normalization/i,
  );
  await assert.rejects(
    store.record({ ...confirmedLearning, learning: "x".repeat(BRAIN_LIMITS.learningCharacters + 1) }),
    /not truncated/i,
  );
  await assert.rejects(
    store.record({
      ...confirmedLearning,
      title: "界".repeat(BRAIN_LIMITS.titleCharacters),
      learning: "界".repeat(BRAIN_LIMITS.learningCharacters),
    }),
    /byte limit.*not truncated/i,
  );
});

test("rejects representative prohibited source payloads", async (t) => {
  const { store } = await temporaryStore(t);
  const prohibited = [
    "Page text: copied customer-facing content",
    "Open https://example.test/private",
    "CSS selector: .deal-card",
    "Stack trace: at render (Widget.jsx:12:4)",
    "Screenshot: data:image/png;base64,AAAA",
    "Voice transcript: change the customer record",
    "Pairing code: ABCD12",
    "Customer name: Example Person",
    "Customer: Jane Doe at 123 Main Street, Seattle WA 98101",
    "Use AWS key AKIAIOSFODNN7EXAMPLE",
    "secret=not-for-storage",
  ];

  for (const learning of prohibited) {
    await assert.rejects(
      store.record({ ...confirmedLearning, learning }),
      /not saved|redaction/i,
      learning,
    );
  }
});

test("allows concise design tokens without mistaking hex colors for selectors", async (t) => {
  const { store } = await temporaryStore(t);
  const saved = await store.record({
    ...confirmedLearning,
    learning: "Use purple #6d28d9 as the primary brand accent.",
  });
  assert.equal(saved.learning, "Use purple #6d28d9 as the primary brand accent.");
});

test("appends superseding revisions without overwriting history", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.record(confirmedLearning);
  const firstPath = path.join(store.rootDirectory, "design", first.id, first.revision);
  const firstBytes = await readFile(firstPath, "utf8");

  const second = await store.record({
    ...confirmedLearning,
    learning_id: first.id,
    learning: "Prefer compact icon controls with accessible names and keyboard operation.",
  });

  assert.notEqual(second.revision, first.revision);
  assert.equal(second.supersedesRevision, first.revision);
  assert.equal(await readFile(firstPath, "utf8"), firstBytes);
  assert.equal(
    (await readdir(path.dirname(firstPath))).filter((name) => name.endsWith(".json")).length,
    2,
  );
  const [latest] = await store.list({ category: "design" });
  assert.equal(latest.revision, second.revision);
});

test("serializes revision chains across store instances", async (t) => {
  const { repositoryDirectory, store } = await temporaryStore(t);
  const first = await store.record(confirmedLearning);
  const secondStore = createBrainStore({ repositoryDirectory });
  const appended = await Promise.all([
    store.record({
      ...confirmedLearning,
      learning_id: first.id,
      learning: "Prefer compact controls with accessible names.",
    }),
    secondStore.record({
      ...confirmedLearning,
      learning_id: first.id,
      learning: "Prefer compact controls with keyboard operation.",
    }),
  ]);

  const directSuccessor = appended.find(
    ({ supersedesRevision }) => supersedesRevision === first.revision,
  );
  const finalSuccessor = appended.find(
    ({ supersedesRevision }) => supersedesRevision === directSuccessor?.revision,
  );
  assert.ok(directSuccessor);
  assert.ok(finalSuccessor);
  assert.equal(
    (await readdir(path.join(store.rootDirectory))).includes(".vibink-write.lock"),
    false,
  );
});

test("listing falls back from a corrupt newest revision", async (t) => {
  const { store } = await temporaryStore(t);
  const record = await store.record(confirmedLearning);
  const learningDirectory = path.join(store.rootDirectory, "design", record.id);
  await writeFile(
    path.join(learningDirectory, "9999-12-31T23-59-59-999Z-deadbeef.json"),
    "{ corrupt",
    "utf8",
  );
  const unsafeRevision = "9999-12-31T23-59-59-999Z-feedface.json";
  await writeFile(
    path.join(learningDirectory, unsafeRevision),
    JSON.stringify({
      ...record,
      recordedAt: "9999-12-31T23:59:59.999Z",
      revision: unsafeRevision,
      unexpectedPayload: "must not escape validation",
    }),
    "utf8",
  );

  const listed = await store.list({ category: "design" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].revision, record.revision);
});

test("enforces the total learning bound", async (t) => {
  const { store } = await temporaryStore(t);
  const categoryDirectory = path.join(store.rootDirectory, "design");
  await mkdir(categoryDirectory, { recursive: true });
  await Promise.all(Array.from({ length: BRAIN_LIMITS.learnings }, (_, index) => (
    mkdir(path.join(categoryDirectory, `lrn-${index.toString(16).padStart(32, "0")}`))
  )));

  await assert.rejects(store.record(confirmedLearning), /limited to 200 learnings/i);

});

test("caps list results even when a larger limit is requested", async (t) => {
  const { store } = await temporaryStore(t);
  for (let index = 0; index <= BRAIN_LIMITS.listResults; index += 1) {
    await store.record({
      ...confirmedLearning,
      title: `Compact controls ${index}`,
    });
  }

  const list = await store.list({ limit: Number.MAX_SAFE_INTEGER });
  assert.equal(list.length, BRAIN_LIMITS.listResults);
});

test("enforces the per-learning revision bound", async (t) => {
  const { store } = await temporaryStore(t);
  const record = await store.record(confirmedLearning);
  const learningDirectory = path.join(store.rootDirectory, "design", record.id);
  await Promise.all(Array.from(
    { length: BRAIN_LIMITS.revisionsPerLearning - 1 },
    (_, index) => writeFile(
      path.join(
        learningDirectory,
        `2000-01-01T00-00-00-000Z-${index.toString(16).padStart(8, "0")}.json`,
      ),
      "{}",
      "utf8",
    ),
  ));

  await assert.rejects(
    store.record({ ...confirmedLearning, learning_id: record.id }),
    /already has 25 revisions/i,
  );
});

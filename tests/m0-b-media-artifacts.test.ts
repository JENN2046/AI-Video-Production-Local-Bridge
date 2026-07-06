import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  getMediaArtifact,
  getStoryboardImageTransferGate,
  openM0Database,
  registerMediaArtifact
} from "../src/index.js";

test("M0-B fixture storyboard image becomes an active Media Artifact", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "fixture_path",
          path: "storyboard/shot_001.png"
        }
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.artifact.status, "active");
    assert.equal(result.artifact.role, "storyboard_image");
    assert.equal(result.artifact.artifact_type, "image");
    assert.equal(existsSync(result.artifact.storage.uri), true);
    assert.equal(readFileSync(result.artifact.storage.uri).length > 0, true);
    assert.deepEqual(getMediaArtifact(db, result.artifact.artifact_id), result.artifact);
  } finally {
    db.close();
  }
});

test("M0-B pending user upload is persisted as pending_upload", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "pending_user_upload",
          filename: "future.png",
          mime_type: "image/png"
        }
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.artifact.status, "pending_upload");
    assert.equal(result.artifact.storage.uri, "");
  } finally {
    db.close();
  }
});

test("M0-B accessible_uri is registered as inaccessible metadata without claiming transfer", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "https://example.test/storyboard/shot_001.png",
          filename: "shot_001.png",
          mime_type: "image/png"
        }
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.artifact.status, "inaccessible");
    assert.equal(result.artifact.storage.uri, "https://example.test/storyboard/shot_001.png");
    assert.equal(result.artifact.storage.filename, "shot_001.png");
    assert.deepEqual(getMediaArtifact(db, result.artifact.artifact_id), result.artifact);
  } finally {
    db.close();
  }
});

test("M0-B rejects invalid accessible_uri values", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "not a url",
          filename: "shot.png",
          mime_type: "image/png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INVALID_ACCESSIBLE_URI");
  } finally {
    db.close();
  }
});

test("M0-B rejects non-http accessible_uri protocols", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "file:///C:/private/storyboard.png",
          filename: "storyboard.png",
          mime_type: "image/png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "EXTERNAL_URI_SCHEME_NOT_ALLOWED");
  } finally {
    db.close();
  }
});

test("M0-B rejects accessible_uri filenames with traversal", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "https://example.test/storyboard/shot.png",
          filename: "../shot.png",
          mime_type: "image/png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STORAGE_PATH_NOT_ALLOWED");
  } finally {
    db.close();
  }
});

test("M0-B blocks path traversal fixture paths", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "fixture_path",
          path: "../outside.png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STORAGE_PATH_NOT_ALLOWED");
  } finally {
    db.close();
  }
});

test("M0-B rejects missing fixture files as unreadable", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "fixture_path",
          path: "storyboard/missing.png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "MEDIA_FILE_NOT_READABLE");
  } finally {
    db.close();
  }
});

test("M0-B rejects invalid artifact role/type combinations", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "video",
        role: "storyboard_image",
        source: {
          kind: "fixture_path",
          path: "storyboard/shot_001.png"
        }
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INVALID_ARTIFACT_ROLE");
  } finally {
    db.close();
  }
});

test("M0-B reports fixture transfer separately from external transfer", () => {
  assert.deepEqual(getStoryboardImageTransferGate(), {
    fixture_path: "PASS",
    external_transfer_path: "NOT_TESTED"
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCS, docBody, docById } from "../docs.ts";

describe("docs", () => {
  it("opens on the service, including how to uninstall it", () => {
    assert.equal(DOCS[0]?.id, "service");
    const page = docById("service");
    assert.ok(page);
    assert.match(page.title, /service/i);
    const mac = docBody(page, "mac");
    const linux = docBody(page, "linux");
    assert.match(mac, /pgrep -lx twanagent-server/);
    assert.match(mac, /killall twanagent-server/);
    assert.doesNotMatch(mac, /pkill/);
    assert.match(linux, /pgrep -af \/twanagent-server/);
    assert.match(linux, /pkill -f '\[\/\]twanagent-server'/);
    assert.doesNotMatch(linux, /killall/);
    assert.match(mac, /rm -rf "\$HOME\/\.twanagent"/);
    assert.match(mac, /sed -i ''/);
    assert.match(mac, /\.zprofile/);
    assert.match(linux, /sed -i '\//);
    assert.match(linux, /\.bashrc/);
    assert.doesNotMatch(linux, /sed -i ''/);
    assert.match(mac, /Remove does not delete the remote files/);
    assert.match(linux, /Remove does not delete the remote files/);
  });

  it("does not invent a second page", () => {
    assert.equal(docById("missing"), undefined);
  });
});

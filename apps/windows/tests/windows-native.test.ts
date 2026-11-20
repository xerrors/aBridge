import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsNativeDriver } from "../src/windows-native.js";
import { Computer } from "../src/computer.js";
import type { NativeObservation } from "../src/native.js";
import { powershellPath } from "../src/windows-security.js";
import { WINDOWS_SCRIPT } from "../src/windows-script.js";
import { DesktopError } from "../src/errors.js";

test("closed Windows driver never creates a helper", async () => {
  const driver = new WindowsNativeDriver();
  await driver.shutdown();
  await assert.rejects(driver.apps(), { code: "driver_closed" });
});

test("aborted request never starts Windows helper or dispatches input", async () => {
  const driver = new WindowsNativeDriver();
  const controller = new AbortController();
  controller.abort(new Error("cancel-before-dispatch"));
  await assert.rejects(
    driver.act("cancel", { action: "key", key: "enter", target: { desktop: true } }, controller.signal),
    /cancel-before-dispatch/,
  );
  await driver.shutdown();
});

test(
  "Windows capture geometry preserves PNG size and pixel mapping at 1920, 2160 and 3840 pixels",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "abridge-capture-size-"));
    const source = join(root, "bundled.ps1");
    const harness = join(root, "geometry.ps1");
    await writeFile(source, "\ufeff" + WINDOWS_SCRIPT, "utf8");
    await writeFile(
      harness,
      String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Bundled helper does not parse'}
foreach($name in @('Capture-Size','Point-For','Refuse')){
 $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
 if(-not $definition){throw ('Missing bundled function: '+$name)}
 . ([ScriptBlock]::Create($definition.Extent.Text))
}
$results=@()
foreach($dimensions in @(@(1920,1080),@(2160,1368),@(3840,2160))){
 $bounds=@{x=17;y=31;width=$dimensions[0];height=$dimensions[1]}
 $size=Capture-Size $bounds
 $capture=@{pixels=$true;bounds=$bounds;width=$size.width;height=$size.height}
 $mapped=Point-For $capture ([int]($size.width/2)) ([int]($size.height/2))
 $original=New-Object Drawing.Bitmap($bounds.width,$bounds.height)
 $drawing=[Drawing.Graphics]::FromImage($original)
 $scaled=$null;$resizer=$null;$stream=$null
 try{
  $drawing.Clear([Drawing.Color]::Blue)
  $drawing.FillRectangle([Drawing.Brushes]::Red,([int]($bounds.width/2)-8),([int]($bounds.height/2)-8),16,16)
  $scaled=New-Object Drawing.Bitmap($size.width,$size.height)
  $resizer=[Drawing.Graphics]::FromImage($scaled)
  $resizer.DrawImage($original,0,0,$size.width,$size.height)
  $stream=New-Object IO.MemoryStream
  $scaled.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
  $results+=@{source_width=$bounds.width;width=$size.width;height=$size.height;mapped=$mapped;center=$scaled.GetPixel([int]($size.width/2),[int]($size.height/2)).ToArgb();png=[Convert]::ToBase64String($stream.ToArray())}
 }finally{if($stream){$stream.Dispose()};if($resizer){$resizer.Dispose()};if($scaled){$scaled.Dispose()};$drawing.Dispose();$original.Dispose()}
}
ConvertTo-Json -InputObject $results -Depth 5 -Compress
`,
      "utf8",
    );
    const child = spawn(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness, "-Source", source],
      { windowsHide: true },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    const closed = once(child, "close");
    const deadline = setTimeout(() => child.kill(), 20000);
    try {
      const [code] = await closed;
      assert.equal(code, 0, errors);
      const results = JSON.parse(output.replace(/^\ufeff/, "")) as Array<{
        source_width: number;
        width: number;
        height: number;
        mapped: number[];
        center: number;
        png: string;
      }>;
      assert.equal(results.length, 3);
      for (const [index, expected] of [
        { source: 1920, size: [1920, 1080], mapped: [977, 571] },
        { source: 2160, size: [1920, 1216], mapped: [1097, 715] },
        { source: 3840, size: [1920, 1080], mapped: [1937, 1111] },
      ].entries()) {
        const result = results[index]!;
        assert.equal(result.source_width, expected.source);
        assert.deepEqual([result.width, result.height], expected.size);
        assert.deepEqual(result.mapped, expected.mapped);
        assert.equal(result.center, -65536, "the mapped physical center appears red in the scaled image");
        const png = Buffer.from(result.png, "base64");
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], expected.size);
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows native fixture: identity, UIA, unicode, screenshot, stale capture, cancel, release",
  {
    skip: process.platform !== "win32" || process.env.ABRIDGE_WINDOWS_LIVE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "abridge-fixture-"));
    const receipt = join(root, "receipt.json");
    const control = join(root, "control");
    const fixture = spawn(
      powershellPath,
      [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("tools/fixtures/windows.ps1"),
        "-Receipt",
        receipt,
        "-Control",
        control,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let fixtureErrors = "";
    fixture.stderr.on("data", (chunk: Buffer) => {
      fixtureErrors = (fixtureErrors + chunk.toString("utf8")).slice(-8000);
    });
    const driver = new WindowsNativeDriver();
    try {
      assert.equal((await driver.diagnostics()).driver !== undefined, true);
      let window;
      for (let i = 0; i < 30; i++) {
        window = (await driver.windows(fixture.pid)).find((w) => w.title === "aBridge Windows Fixture");
        if (window) break;
        await delay(200);
      }
      assert.ok(window, "the test's own fixture window appears");
      const app = (await driver.apps()).find((a) => a.pid === fixture.pid);
      assert.ok(app?.bundle_id);
      await driver.open(app.bundle_id);
      await delay(300);
      const target = { pid: window.pid, window_id: window.window_id };
      const observe = () => driver.observe("fixture", target, true);
      const command = async (value: string) => {
        await rm(control + ".done", { force: true });
        // Never expose a still-open writer to the fixture's File.ReadAllText.
        await writeFile(control + ".pending", value);
        await rename(control + ".pending", control);
        let acknowledged = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const failure = await readFile(control + ".fixture-error", "utf8").catch(() => "");
          assert.equal(failure, "", `fixture command ${value} failed: ${failure}`);
          if ((await readFile(control + ".done", "utf8").catch(() => "")) === value) {
            acknowledged = true;
            break;
          }
          assert.equal(fixture.exitCode, null, `fixture exited during ${value}: ${fixtureErrors}`);
          await delay(50);
        }
        assert.equal(acknowledged, true, `fixture command ${value} did not finish`);
        await delay(250);
      };
      const token = (o: NativeObservation, name: string) => {
        const el = o.elements.find((e) => e.label === name);
        assert.ok(el?.token, `UIA element ${name}: ${JSON.stringify(o.elements)}`);
        return el.token;
      };
      t.diagnostic("fixture window focused; observing UIA and screenshot");
      let observation: NativeObservation;
      try {
        observation = await observe();
      } catch (error) {
        t.diagnostic(
          JSON.stringify(
            (await driver.windows())
              .filter(
                (w) =>
                  w.z_index! >= window.z_index! &&
                  w.bounds.x < window.bounds.x + window.bounds.width &&
                  w.bounds.y < window.bounds.y + window.bounds.height &&
                  w.bounds.x + w.bounds.width > window.bounds.x &&
                  w.bounds.y + w.bounds.height > window.bounds.y,
              )
              .map((w) => ({ pid: w.pid, id: w.window_id, bounds: w.bounds, focused: w.is_focused })),
          ),
        );
        throw error;
      }
      assert.equal(observation.mime_type, "image/png");
      assert.ok(observation.width && observation.height);
      assert.equal(observation.frame_valid, true);
      const png = Buffer.from(observation.image_base64!, "base64");
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), observation.width);
      assert.equal(png.readUInt32BE(20), observation.height);
      assert.equal(observation.elements.find((e) => e.label === "Fixture password")?.role, "password");
      assert.ok(!JSON.stringify(observation.elements).includes("fixture-secret-must-not-leak"));
      t.diagnostic("UIA3 and password/screenshot assertions passed; checking public observation");
      const computer = new Computer(driver);
      const publicObservation = await computer.observe("public-contract", { ...target, screenshot: true });
      assert.equal(publicObservation.pixel_actions, true);
      assert.ok(!JSON.stringify(publicObservation).includes("fixture-secret-must-not-leak"));
      await computer.closeSession("public-contract");
      t.diagnostic("checking deep controls, structural containers, readonly fields and target focus");
      const deepEdit = observation.elements.find((element) => element.label === "Fixture deep text");
      const deepButton = observation.elements.find((element) => element.label === "Fixture deep button");
      assert.ok(deepEdit && deepEdit.depth > 16, "editable input is discovered beyond the old depth limit");
      assert.ok(
        deepButton && deepButton.depth > 16,
        "Invoke button is discovered beyond the old depth limit",
      );
      assert.ok(deepEdit.actions?.includes("type"));
      assert.ok(deepButton.actions?.includes("click"));
      const structural = observation.elements.find(
        (element) => element.label === "Fixture structural container",
      );
      assert.ok(structural, "fixture exposes an ordinary structural container");
      assert.ok(!structural.actions?.includes("click"), "structural panes must not claim click support");
      const readonly = observation.elements.find((element) => element.label === "Fixture readonly");
      assert.ok(readonly);
      assert.equal(readonly.value, "unchanged readonly");
      assert.ok(!readonly.actions?.includes("type"), "readonly ValuePattern must not advertise type");
      assert.deepEqual(readonly.actions, [], "readonly text has no semantic action or retained reference");
      await assert.rejects(
        driver.act("fixture", {
          action: "type",
          text: "must not change",
          native_ref: token(observation, "Fixture readonly"),
          capture_id: observation.capture_id,
          target,
        }),
        { code: "stale_element", outcome: "refused" },
      );
      observation = await observe();
      assert.equal(
        observation.elements.find((element) => element.label === "Fixture readonly")?.value,
        "unchanged readonly",
      );
      await driver.act("fixture", {
        action: "type",
        text: "deep fixture input",
        native_ref: token(observation, "Fixture deep text"),
        capture_id: observation.capture_id,
        target,
      });
      observation = await observe();
      await driver.act("fixture", {
        action: "click",
        native_ref: token(observation, "Fixture deep button"),
        capture_id: observation.capture_id,
        target,
      });
      await delay(200);
      const deepReceipt = JSON.parse((await readFile(control + ".deep", "utf8")).replace(/^\ufeff/, "")) as {
        count: number;
        text: string;
      };
      assert.deepEqual(deepReceipt, { count: 1, text: "deep fixture input" });
      await command("foreign-foreground");
      await assert.rejects(observe(), { code: "focus_changed" });
      const background = await driver.observe("fixture", target, false);
      assert.equal(background.is_focused, false);
      assert.equal(background.image_base64, undefined);
      await driver.open(app.bundle_id);
      await delay(100);
      assert.equal(
        (await driver.windows(fixture.pid)).find((entry) => entry.window_id === target.window_id)?.is_focused,
        true,
        "activation remains focused after the helper detaches its input queues",
      );
      await command("restore-foreground");
      observation = await observe();
      assert.equal(observation.is_focused, true);
      assert.ok(observation.image_base64, "reactivated target has a fresh usable screenshot");
      t.diagnostic("public observation passed; starting semantic Unicode input");
      const oldCapture = observation.capture_id;
      await driver.act("fixture", {
        action: "type",
        text: "中文 Unicode 👋",
        native_ref: token(observation, "Fixture text"),
        capture_id: observation.capture_id,
        target,
      });
      await assert.rejects(
        driver.act("fixture", { action: "key", key: "enter", capture_id: oldCapture, target }),
        { code: "stale_capture" },
      );
      t.diagnostic("semantic Unicode input passed");
      observation = await observe();
      assert.equal(observation.elements.find((e) => e.label === "Fixture text")?.value, "中文 Unicode 👋");
      await driver.act("fixture", {
        action: "click",
        native_ref: token(observation, "Fixture toggle"),
        capture_id: observation.capture_id,
        target,
      });
      // A true UIA Invoke operation remains usable without pixel observations.
      observation = await driver.observe("fixture", target, false);
      assert.equal(observation.image_base64, undefined);
      await driver.act("fixture", {
        action: "click",
        native_ref: token(observation, "Record fixture"),
        capture_id: observation.capture_id,
        target,
      });
      await delay(200);
      const recorded = JSON.parse((await readFile(receipt, "utf8")).replace(/^\ufeff/, ""));
      assert.equal(recorded.count, 1);
      assert.equal(recorded.text, "中文 Unicode 👋");
      assert.equal(recorded.checked, true);
      observation = await driver.observe("fixture", target, false);
      const plainText = observation.elements.find((element) => element.label === "Fixture pointer");
      assert.equal(plainText?.role, "Text");
      assert.deepEqual(plainText?.actions, [], "named text without a UIA pattern has no click capability");
      // A guessed raw token cannot turn no-screenshot text into a coordinate click.
      await assert.rejects(
        driver.act("fixture", {
          action: "click",
          native_ref: token(observation, "Fixture pointer"),
          capture_id: observation.capture_id,
          target,
        }),
        { code: "stale_element", outcome: "refused" },
      );
      await assert.rejects(
        driver.act("fixture", {
          action: "click",
          native_ref: token(observation, "Fixture text"),
          capture_id: observation.capture_id,
          target,
        }),
        { code: "unsupported_element_action", outcome: "refused" },
      );
      for (const gesture of [
        { action: "double_click" },
        { action: "click", button: "right" },
        { action: "click", button: "middle" },
        { action: "click", modifiers: ["ctrl"] },
      ]) {
        await assert.rejects(
          driver.act("fixture", {
            ...gesture,
            native_ref: token(observation, "Record fixture"),
            capture_id: observation.capture_id,
            target,
          }),
          { code: "unsupported_element_action", outcome: "refused" },
        );
      }
      await command("state");
      const refusedState = JSON.parse((await readFile(control + ".state", "utf8")).replace(/^\ufeff/, ""));
      assert.equal(refusedState.count, recorded.count, "unsupported gestures never invoke the button");
      assert.equal(refusedState.text, recorded.text);
      assert.deepEqual(
        refusedState.events,
        recorded.events,
        "unsupported references dispatch no physical input",
      );
      await command("geometry");
      const geometry = JSON.parse((await readFile(control + ".geometry", "utf8")).replace(/^\ufeff/, "")) as {
        pointer: { x: number; y: number; width: number; height: number };
        edit: { x: number; y: number; width: number; height: number };
      };
      const point = (r: typeof geometry.pointer, fraction = 0.5) => ({
        x: ((r.x + r.width * fraction - window.bounds.x) * observation.width!) / window.bounds.width,
        y: ((r.y + r.height * 0.5 - window.bounds.y) * observation.height!) / window.bounds.height,
      });
      // Physical gestures use independent fixture geometry and a current image.
      for (const button of ["right", "middle"] as const) {
        observation = await observe();
        await driver.act("fixture", {
          action: "click",
          button,
          ...point(geometry.pointer),
          capture_id: observation.capture_id,
          target,
        });
      }
      observation = await observe();
      await driver.act("fixture", {
        action: "double_click",
        ...point(geometry.pointer),
        capture_id: observation.capture_id,
        target,
      });
      observation = await observe();
      await driver.act("fixture", {
        action: "click",
        ...point(geometry.edit),
        capture_id: observation.capture_id,
        target,
      });
      observation = await observe();
      await driver.act("fixture", { action: "key", key: "end", capture_id: observation.capture_id, target });
      observation = await observe();
      await driver.act("fixture", {
        action: "type",
        text: " 键鼠",
        capture_id: observation.capture_id,
        target,
      });
      observation = await observe();
      await driver.act("fixture", {
        action: "click",
        native_ref: token(observation, "Record fixture"),
        capture_id: observation.capture_id,
        target,
      });
      await delay(200);
      const effects = JSON.parse((await readFile(receipt, "utf8")).replace(/^\ufeff/, ""));
      assert.equal(effects.text, "中文 Unicode 👋 键鼠");
      assert.equal(effects.events.Right, 1);
      assert.equal(effects.events.Middle, 1);
      assert.equal(effects.events.Left, 2);
      assert.ok(effects.events.keys > 0);
      observation = await observe();
      await driver.act("fixture", {
        action: "move",
        ...point(geometry.pointer),
        capture_id: observation.capture_id,
        target,
      });
      const scrollObservation = await computer.observe("explicit-scroll", { ...target, screenshot: true });
      const scrollGeometry = scrollObservation.geometry as { width: number; height: number };
      await computer.act("explicit-scroll", {
        observation_id: scrollObservation.observation_id,
        action: {
          type: "scroll",
          x:
            ((geometry.edit.x + geometry.edit.width / 2 - window.bounds.x) * scrollGeometry.width) /
            window.bounds.width,
          y:
            ((geometry.edit.y + geometry.edit.height / 2 - window.bounds.y) * scrollGeometry.height) /
            window.bounds.height,
          delta_y: -40,
        },
        observe_after: false,
      });
      await computer.closeSession("explicit-scroll");
      observation = await observe();
      const end = point(geometry.pointer, 0.75);
      await driver.act("fixture", {
        action: "drag",
        ...point(geometry.pointer, 0.25),
        to_x: end.x,
        to_y: end.y,
        capture_id: observation.capture_id,
        target,
      });
      observation = await observe();
      const cancellation = new AbortController();
      const dragging = driver.act(
        "fixture",
        {
          action: "drag",
          modifiers: ["ctrl"],
          ...point(geometry.pointer, 0.25),
          to_x: end.x,
          to_y: end.y,
          capture_id: observation.capture_id,
          target,
        },
        cancellation.signal,
      );
      void dragging.catch(() => {});
      try {
        let dispatched = false;
        for (let i = 0; i < 100; i++) {
          try {
            dispatched = (await readFile(control + ".drag-started", "utf8")) === "started";
          } catch {}
          if (dispatched) break;
          await delay(5);
        }
        assert.equal(dispatched, true, "cancel only after the fixture receives mouse-down");
        cancellation.abort();
        await assert.rejects(dragging, { code: "cancelled", outcome: "outcome_unknown" });
      } finally {
        cancellation.abort();
        await dragging.catch(() => {});
      }
      await command("key-state");
      assert.deepEqual(JSON.parse((await readFile(control + ".keys", "utf8")).replace(/^\ufeff/, "")), []);
      observation = await observe();
      await driver.act("fixture", {
        action: "click",
        native_ref: token(observation, "Record fixture"),
        capture_id: observation.capture_id,
        target,
      });
      await delay(200);
      const pointerEffects = JSON.parse((await readFile(receipt, "utf8")).replace(/^\ufeff/, ""));
      assert.ok(pointerEffects.events.Left >= 3);
      assert.equal(pointerEffects.events.wheel, 120);
      assert.ok(
        pointerEffects.wheel_point.x >= geometry.edit.x &&
          pointerEffects.wheel_point.x < geometry.edit.x + geometry.edit.width,
      );
      assert.ok(
        pointerEffects.wheel_point.y >= geometry.edit.y &&
          pointerEffects.wheel_point.y < geometry.edit.y + geometry.edit.height,
        "the public scroll action reaches the explicit child region, not the window center",
      );
      observation = await observe();
      await assert.rejects(
        driver.act("other-session", {
          action: "click",
          native_ref: token(observation, "Record fixture"),
          capture_id: observation.capture_id,
          target,
        }),
        { code: "stale_capture" },
      );
      await assert.rejects(
        driver.act("fixture", { action: "click", x: -1, y: 0, capture_id: observation.capture_id, target }),
        { code: "invalid_coordinates" },
      );
      await driver.release("fixture");
      await assert.rejects(
        driver.act("fixture", { action: "key", key: "enter", capture_id: observation.capture_id, target }),
        { code: "stale_capture" },
      );
      await assert.rejects(driver.open("win.not-discovered"), { code: "app_not_found" });
      await assert.rejects(driver.observe("missing", { pid: window.pid, window_id: 1 }, true));
      await assert.rejects(
        driver.observe("wrong-owner", { pid: window.pid + 1, window_id: window.window_id }, false),
        {
          code: "window_identity_changed",
        },
      );
      const protectedDriver = new WindowsNativeDriver();
      const originalProtectedPids = process.env.ABRIDGE_PROTECTED_PIDS;
      try {
        process.env.ABRIDGE_PROTECTED_PIDS = String(fixture.pid);
        await protectedDriver.diagnostics();
      } finally {
        if (originalProtectedPids === undefined) delete process.env.ABRIDGE_PROTECTED_PIDS;
        else process.env.ABRIDGE_PROTECTED_PIDS = originalProtectedPids;
      }
      try {
        await assert.rejects(protectedDriver.observe("protected", target, false), {
          code: "protected_target",
        });
      } finally {
        await protectedDriver.shutdown();
      }
      await command("minimize");
      await assert.rejects(observe(), { code: "window_minimized" });
      await driver.open(app.bundle_id);
      assert.equal(
        (await driver.windows(fixture.pid)).find((w) => w.window_id === window.window_id)?.is_focused,
        true,
      );
      observation = await observe();
      await command("move");
      await assert.rejects(
        driver.act("fixture", { action: "key", key: "enter", capture_id: observation.capture_id, target }),
        { code: "stale_capture" },
      );
      await command("cover");
      await assert.rejects(observe(), { code: "target_occluded" });
      await command("uncover");
      observation = await observe();
      // Ownership and NOACTIVATE alone must not exempt interactive or foreign windows.
      for (const popup of ["owned-interactive", "foreign-passive"] as const) {
        await command(popup);
        try {
          const info = JSON.parse((await readFile(control + ".popup", "utf8")).replace(/^\ufeff/, "")) as {
            owner: number;
            foreground: number;
            extended_style: number;
            bounds: { x: number; y: number; width: number; height: number };
          };
          assert.equal(
            info.foreground,
            target.window_id,
            `popup fixture keeps owner focused: ${JSON.stringify(info)}`,
          );
          if (popup === "owned-interactive") assert.equal(info.owner, target.window_id);
          else assert.notEqual(info.owner, target.window_id);
          assert.ok(info.extended_style & 0x08000000, "both cases carry NOACTIVATE");
          await assert.rejects(observe(), { code: "target_occluded" });
          if (popup === "owned-interactive") {
            const current = (await driver.windows(fixture.pid)).find(
              (entry) => entry.window_id === target.window_id,
            )!;
            await assert.rejects(
              driver.act("fixture", {
                action: "click",
                x: Math.floor(
                  ((info.bounds.x + info.bounds.width / 2 - current.bounds.x) * observation.width!) /
                    current.bounds.width,
                ),
                y: Math.floor(
                  ((info.bounds.y + info.bounds.height / 2 - current.bounds.y) * observation.height!) /
                    current.bounds.height,
                ),
                capture_id: observation.capture_id,
                target,
              }),
              { code: "target_occluded", outcome: "refused" },
            );
            await assert.rejects(readFile(control + ".popup-dispatched"), { code: "ENOENT" });
          }
        } finally {
          await command("popup-close");
        }
        observation = await observe();
      }
      // Even a mouse-transparent owned hint must not permit clicking hidden pixels.
      // Cover both compositor-backed hints (no LAYERED flag) and layered hints.
      for (const [index, popup] of ["owned-passive", "owned-layered-passive"].entries()) {
        await command(popup);
        try {
          const info = JSON.parse((await readFile(control + ".popup", "utf8")).replace(/^\ufeff/, "")) as {
            owner: number;
            foreground: number;
            extended_style: number;
            bounds: { x: number; y: number; width: number; height: number };
          };
          assert.equal(info.owner, target.window_id);
          assert.equal(
            info.foreground,
            target.window_id,
            `popup fixture keeps owner focused: ${JSON.stringify(info)}`,
          );
          assert.equal(info.extended_style & 0x080000a0, 0x080000a0);
          assert.equal(Boolean(info.extended_style & 0x00080000), popup === "owned-layered-passive");
          observation = await observe();
          assert.ok(
            observation.image_base64,
            "owned passive hint remains visible in a valid target screenshot",
          );
          assert.equal(observation.is_focused, true);
          assert.equal(observation.frame_valid, true);
          const current = (await driver.windows(fixture.pid)).find(
            (entry) => entry.window_id === target.window_id,
          )!;
          const pixelPoint = (rect: typeof info.bounds) => ({
            x: Math.floor(
              ((rect.x + rect.width / 2 - current.bounds.x) * observation.width!) / current.bounds.width,
            ),
            y: Math.floor(
              ((rect.y + rect.height / 2 - current.bounds.y) * observation.height!) / current.bounds.height,
            ),
          });
          await assert.rejects(
            driver.act("fixture", {
              action: "click",
              ...pixelPoint(info.bounds),
              capture_id: observation.capture_id,
              target,
            }),
            { code: "target_occluded", outcome: "refused" },
          );
          await command("geometry");
          const freshGeometry = JSON.parse(
            (await readFile(control + ".geometry", "utf8")).replace(/^\ufeff/, ""),
          ) as {
            edit: typeof info.bounds;
          };
          await driver.act("fixture", {
            action: "click",
            ...pixelPoint(freshGeometry.edit),
            capture_id: observation.capture_id,
            target,
          });
          await delay(100);
          assert.equal(await readFile(control + ".popup-outside", "utf8"), String(index + 1));
        } finally {
          await command("popup-close");
        }
        observation = await observe();
      }
      // A window outside the visible frame can overlap only the invisible resize border.
      // The old GetWindowRect-based guard falsely rejected this adjacent window.
      await command("frame");
      type FrameRect = { Left: number; Top: number; Right: number; Bottom: number };
      const frame = JSON.parse((await readFile(control + ".frame", "utf8")).replace(/^\ufeff/, "")) as {
        outer: FrameRect;
        visible: FrameRect;
        hr: number;
      };
      assert.equal(frame.hr, 0);
      assert.ok(frame.outer.Bottom > frame.visible.Bottom, "fixture exposes an invisible resize border");
      await command("border-cover");
      t.diagnostic(`checking visible-frame neighbour: ${JSON.stringify(frame)}`);
      observation = await observe();
      assert.ok(observation.image_base64, "adjacent window must not block visible-frame capture");
      await command("uncover");
      const frameBounds = (await driver.windows(fixture.pid)).find((w) => w.window_id === window.window_id)!;
      assert.deepEqual(frameBounds.bounds, {
        x: frame.visible.Left,
        y: frame.visible.Top,
        width: frame.visible.Right - frame.visible.Left,
        height: frame.visible.Bottom - frame.visible.Top,
      });
      await command("maximize");
      observation = await observe();
      assert.ok(observation.image_base64, "maximized window has a usable screenshot");
      await command("restore");
      await command("workarea-edge");
      const workarea = JSON.parse((await readFile(control + ".workarea", "utf8")).replace(/^\ufeff/, "")) as {
        edge: "left" | "top" | "right" | "bottom" | null;
        bounds?: { x: number; y: number; width: number; height: number };
      };
      if (!workarea.edge) {
        t.diagnostic("SKIP workarea-edge: this monitor has no system-reserved work-area edge");
      } else {
        assert.ok(workarea.bounds);
        t.diagnostic(`checking system-reserved ${workarea.edge} edge`);
        observation = await observe();
        assert.ok(
          observation.image_base64,
          "a frame overlapping a reserved edge is cropped to usable pixels",
        );
        const croppedWindow = (await driver.windows(fixture.pid)).find(
          (w) => w.window_id === window.window_id,
        )!;
        assert.deepEqual(croppedWindow.bounds, workarea.bounds);
        // This fixture is smaller than the image downscaling limit, so its returned
        // image geometry must match the physical cropped bounds exactly.
        assert.equal(observation.width, workarea.bounds.width);
        assert.equal(observation.height, workarea.bounds.height);
        await driver.act("fixture", {
          action: "move",
          x:
            workarea.edge === "left"
              ? 0
              : workarea.edge === "right"
                ? observation.width! - 1
                : Math.floor(observation.width! / 2),
          y:
            workarea.edge === "top"
              ? 0
              : workarea.edge === "bottom"
                ? observation.height! - 1
                : Math.floor(observation.height! / 2),
          capture_id: observation.capture_id,
          target,
        });
        await command("cover");
        await assert.rejects(observe(), { code: "target_occluded" });
        await command("uncover");
        await command("workarea-restore");
      }
      // Inject failure only into a test-owned copy of the bundled helper. The
      // production script has no fault-injection switch or special fixture path.
      const rootLookup =
        "try {\n   $root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)\n   if($null -ne $root)";
      const uiaReady = "[ABUia]::Ready()";
      const candidate = "$candidate=@{node=$node;element=$el}";
      assert.equal(WINDOWS_SCRIPT.split(rootLookup).length, 2, "exact root lookup injection point");
      assert.equal(WINDOWS_SCRIPT.split(uiaReady).length, 2, "exact diagnostics injection point");
      assert.equal(WINDOWS_SCRIPT.split(candidate).length, 2, "exact completed-node delay injection point");
      const unavailableScript = WINDOWS_SCRIPT.replace(
        rootLookup,
        rootLookup.replace(
          "$root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)",
          "if($a.session -eq 'uia-unavailable'){throw 'fixture_uia_root_unavailable'};$root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)",
        ),
      )
        .replace(uiaReady, "$(throw 'fixture_uia_initialization_unavailable')")
        .replace(
          candidate,
          "if($a.session -eq 'uia-budget' -and $c.Name -eq 'Record fixture'){Start-Sleep -Milliseconds 3100};" +
            candidate,
        );
      assert.equal(
        unavailableScript.split(
          "try {$root=[ABUia]::FromHandle([IntPtr]$a.target.window_id)}catch{Refuse 'stale_element'}",
        ).length,
        2,
        "Act keeps its unmodified target-root ancestry validation",
      );
      const helperFile = join(root, "uia-unavailable.ps1");
      await writeFile(helperFile, "\ufeff" + unavailableScript, "utf8");
      const helper = spawn(
        powershellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-MTA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperFile,
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ABRIDGE_CANCEL_FILE: join(root, "fallback-cancel"),
            ABRIDGE_OCCLUSION_DIAGNOSTIC: join(root, "fallback-occlusion.json"),
            ABRIDGE_PROTECTED_PIDS: String(process.pid),
          },
        },
      );
      const helperClosed = once(helper, "close");
      helper.stderr.resume();
      const helperLines = createInterface({ input: helper.stdout });
      const replies = helperLines[Symbol.asyncIterator]();
      let helperId = 0;
      const callHelper = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
        const id = ++helperId;
        helper.stdin.write(JSON.stringify({ id, op, args }) + "\n");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const line = await Promise.race([
            replies.next(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(Error("UIA-unavailable helper timed out")), 30000);
            }),
          ]);
          assert.equal(line.done, false, "test-owned helper returns a response");
          const reply = JSON.parse(line.value!) as { id: number; ok: boolean; data: T; error?: string };
          assert.equal(reply.id, id);
          if (!reply.ok) {
            t.diagnostic(`fallback helper ${op} refused: ${reply.error}`);
            t.diagnostic(
              await readFile(join(root, "fallback-occlusion.json"), "utf8").catch(
                () => "No occlusion diagnostic recorded",
              ),
            );
            const windows = await driver.windows();
            const targetWindow = windows.find((item) => item.window_id === target.window_id);
            t.diagnostic(
              JSON.stringify(
                windows
                  .filter(
                    (item) =>
                      item.window_id === target.window_id ||
                      (targetWindow &&
                        item.z_index! >= targetWindow.z_index! &&
                        item.bounds.x < targetWindow.bounds.x + targetWindow.bounds.width &&
                        item.bounds.y < targetWindow.bounds.y + targetWindow.bounds.height &&
                        item.bounds.x + item.bounds.width > targetWindow.bounds.x &&
                        item.bounds.y + item.bounds.height > targetWindow.bounds.y),
                  )
                  .slice(0, 20)
                  .map((item) => ({
                    pid: item.pid,
                    id: item.window_id,
                    bounds: item.bounds,
                    z: item.z_index,
                    focused: item.is_focused,
                    on_screen: item.is_on_screen,
                  })),
              ),
            );
          }
          assert.equal(reply.ok, true, reply.error);
          return reply.data;
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        const diagnostic = await callHelper<{
          driver: { ready: boolean; accessibility_ready: boolean };
          permissions: { screen: boolean; input: boolean };
        }>("diagnostics", {});
        assert.equal(diagnostic.driver.accessibility_ready, false);
        assert.equal(diagnostic.driver.ready, true, "UIA failure does not disable Win32 driver readiness");
        assert.equal(diagnostic.permissions.screen, true);
        assert.equal(diagnostic.permissions.input, true);
        // Restore the already-owned fixture after window-style tests and helper
        // startup; this never retries an input or relaxes the foreground guard.
        await driver.open(app.bundle_id);
        await command("geometry");
        const fallbackGeometry = JSON.parse(
          (await readFile(control + ".geometry", "utf8")).replace(/^\ufeff/, ""),
        ) as { edit: { x: number; y: number; width: number; height: number } };
        const fallbackWindow = (await driver.windows(fixture.pid)).find(
          (item) => item.window_id === target.window_id,
        )!;
        assert.equal(fallbackWindow.is_focused, true);
        assert.deepEqual(
          fallbackWindow.bounds,
          frameBounds.bounds,
          "workarea fixture restores its original visible bounds",
        );
        const fallbackObserve = () =>
          callHelper<NativeObservation & { accessibility_status: string }>("observe", {
            session: "uia-unavailable",
            target,
            screenshot: true,
          });
        let fallback = await fallbackObserve();
        assert.equal(fallback.accessibility_status, "unavailable");
        assert.equal(fallback.frame_valid, true);
        assert.equal(fallback.is_focused, true);
        assert.deepEqual(fallback.elements, []);
        assert.ok(fallback.width && fallback.height && fallback.image_base64);
        const fallbackPng = Buffer.from(fallback.image_base64, "base64");
        assert.deepEqual([...fallbackPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(fallbackPng.readUInt32BE(16), fallback.width);
        assert.equal(fallbackPng.readUInt32BE(20), fallback.height);
        const applyFallback = async (action: Record<string, unknown>) => {
          const result = await callHelper<{ status: string }>("act", {
            ...action,
            session: "uia-unavailable",
            target,
            capture_id: fallback.capture_id,
          });
          assert.equal(result.status, "executed");
          fallback = await fallbackObserve();
        };
        // Geometry is emitted independently by our fixture, not recovered from UIA.
        const beforeFallbackReceipt = JSON.parse(
          (await readFile(receipt, "utf8")).replace(/^\ufeff/, ""),
        ) as { count: number };
        assert.ok(Number.isSafeInteger(beforeFallbackReceipt.count));
        const edit = fallbackGeometry.edit;
        await applyFallback({
          action: "click",
          x:
            ((edit.x + edit.width / 2 - fallbackWindow.bounds.x) * fallback.width) /
            fallbackWindow.bounds.width,
          y:
            ((edit.y + edit.height / 2 - fallbackWindow.bounds.y) * fallback.height) /
            fallbackWindow.bounds.height,
        });
        await applyFallback({ action: "key", key: "a", modifiers: ["ctrl"] });
        await applyFallback({ action: "type", text: "UIA unavailable pixel and keyboard fallback" });
        // The fixture's next tab stop is its record button; Enter writes a separate receipt.
        await applyFallback({ action: "key", key: "tab" });
        await applyFallback({ action: "key", key: "enter" });
        const expectedFallback = {
          count: beforeFallbackReceipt.count + 1,
          text: "UIA unavailable pixel and keyboard fallback",
        };
        let fallbackReceipt: { count: number; text: string } | undefined;
        // SendInput confirms dispatch, not completion of the fixture's message loop.
        // Wait for an independent receipt without dispatching Enter a second time.
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            fallbackReceipt = JSON.parse((await readFile(receipt, "utf8")).replace(/^\ufeff/, ""));
          } catch {}
          if (
            fallbackReceipt?.count === expectedFallback.count &&
            fallbackReceipt.text === expectedFallback.text
          )
            break;
          await delay(50);
        }
        if (
          fallbackReceipt?.count !== expectedFallback.count ||
          fallbackReceipt.text !== expectedFallback.text
        ) {
          await command("state");
          t.diagnostic(`fallback fixture state: ${await readFile(control + ".state", "utf8")}`);
        }
        assert.deepEqual(
          { count: fallbackReceipt?.count, text: fallbackReceipt?.text },
          expectedFallback,
          "one Enter dispatch produces exactly one receipt with the typed text",
        );
        t.diagnostic("checking cooperative UIA time budget retains a real screenshot and semantic reference");
        const bounded = await callHelper<NativeObservation & { accessibility_limit: string }>("observe", {
          session: "uia-budget",
          target,
          screenshot: true,
        });
        assert.equal(bounded.accessibility_status, "partial");
        assert.equal(bounded.accessibility_limit, "time_budget");
        assert.equal(bounded.truncated, true);
        assert.equal(bounded.frame_valid, true);
        assert.equal(bounded.is_focused, true);
        assert.ok(bounded.width && bounded.height && bounded.image_base64);
        const boundedPng = Buffer.from(bounded.image_base64, "base64");
        assert.deepEqual([...boundedPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(boundedPng.readUInt32BE(16), bounded.width);
        assert.equal(boundedPng.readUInt32BE(20), bounded.height);
        const timings = JSON.parse(await readFile(join(root, "last-observation.json"), "utf8")) as {
          uia_elapsed_ms: number;
          capture_elapsed_ms: number;
          total_ms: number;
          budget_exhausted: boolean;
          visited: number;
          collected: number;
        };
        assert.equal(timings.budget_exhausted, true);
        assert.ok(timings.uia_elapsed_ms >= 3000);
        assert.ok(timings.total_ms >= timings.uia_elapsed_ms + timings.capture_elapsed_ms);
        assert.ok(timings.visited > 0 && timings.visited < 1500 && timings.collected > 0);
        assert.deepEqual(Object.keys(timings).sort(), [
          "budget_exhausted",
          "capture_elapsed_ms",
          "collected",
          "total_ms",
          "uia_elapsed_ms",
          "visited",
        ]);
        assert.ok(
          bounded.elements.find((element) => element.label === "Record fixture")?.actions?.includes("click"),
        );
        await callHelper("act", {
          session: "uia-budget",
          target,
          capture_id: bounded.capture_id,
          action: "click",
          native_ref: token(bounded, "Record fixture"),
        });
        let boundedReceipt: { count: number; text: string } | undefined;
        for (let attempt = 0; attempt < 60; attempt++) {
          boundedReceipt = JSON.parse((await readFile(receipt, "utf8")).replace(/^\ufeff/, ""));
          if (boundedReceipt?.count === expectedFallback.count + 1) break;
          await delay(50);
        }
        assert.deepEqual(
          { count: boundedReceipt?.count, text: boundedReceipt?.text },
          {
            count: expectedFallback.count + 1,
            text: expectedFallback.text,
          },
          "a reference collected before budget exhaustion still invokes exactly once under normal guards",
        );
      } finally {
        helper.stdin.end();
        const kill = setTimeout(() => helper.kill(), 2000);
        await helperClosed;
        clearTimeout(kill);
        helperLines.close();
      }
      t.diagnostic("checking cross-process hosted controls and fresh UIA ancestry");
      const hosted = spawn(
        powershellPath,
        [
          "-NoProfile",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("tools/fixtures/windows.ps1"),
          "-Receipt",
          receipt,
          "-Control",
          control,
          "-HostWindowId",
          String(target.window_id),
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      const hostedClosed = once(hosted, "close");
      let hostedErrors = "";
      hosted.stderr.on("data", (chunk: Buffer) => {
        hostedErrors = (hostedErrors + chunk.toString("utf8")).slice(-4000);
      });
      let hostedPhase = "starting";
      const phase = (value: string) => {
        hostedPhase = value;
        t.diagnostic(`hosted phase: ${value}`);
      };
      const observeHosted = async () => {
        // The direct driver has no computer_act wait_after_ms. Only retry a
        // refused read while the provider settles; never repeat an input.
        for (let attempt = 0; ; attempt++) {
          try {
            return await observe();
          } catch (error) {
            if (
              attempt >= 10 ||
              !(error instanceof DesktopError) ||
              error.code !== "focus_changed" ||
              error.outcome !== "refused"
            )
              throw error;
            await delay(100);
          }
        }
      };
      try {
        let hostedInfo: { pid: number; window_id: number; root_window_id: number } | undefined;
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            hostedInfo = JSON.parse(
              (await readFile(control + ".hosted-ready", "utf8")).replace(/^\ufeff/, ""),
            );
          } catch {}
          if (hostedInfo) break;
          await delay(100);
        }
        assert.ok(hostedInfo, `hosted fixture starts: ${hostedErrors}`);
        assert.equal(hostedInfo.pid, hosted.pid);
        assert.notEqual(hostedInfo.pid, target.pid, "controls live in a separate fixture process");
        assert.equal(
          hostedInfo.root_window_id,
          target.window_id,
          "child HWND is embedded in the target root",
        );
        phase("initial-open");
        await driver.open(app.bundle_id);
        phase("initial-observe");
        observation = await observeHosted();
        phase("type");
        try {
          await driver.act("fixture", {
            action: "type",
            text: "cross-process input",
            native_ref: token(observation, "Fixture hosted text"),
            capture_id: observation.capture_id,
            target,
          });
        } catch (error) {
          if (
            !(error instanceof DesktopError) ||
            error.code !== "focus_changed" ||
            error.outcome !== "outcome_unknown"
          )
            throw error;
          phase("guarded uncertain-result recovery");
          let state:
            { text: string; foreground: number; foreground_root: number; top_level: boolean } | undefined;
          for (let attempt = 0; attempt < 60; attempt++) {
            try {
              state = JSON.parse((await readFile(control + ".hosted-state", "utf8")).replace(/^\ufeff/, ""));
            } catch {}
            if (
              state?.text === "cross-process input" &&
              state.foreground === target.window_id &&
              state.foreground_root === target.window_id &&
              state.top_level === false
            )
              break;
            await delay(50);
          }
          assert.deepEqual(
            state,
            {
              text: "cross-process input",
              foreground: target.window_id,
              foreground_root: target.window_id,
              top_level: false,
            },
            "verify the dispatched write and restored target from the fixture; never retype",
          );
        }
        phase("after-type-observe");
        observation = await observeHosted();
        assert.equal(
          observation.elements.find((element) => element.label === "Fixture hosted text")?.value,
          "cross-process input",
          "fresh UIA observation confirms the independently recorded value before clicking",
        );
        phase("click");
        try {
          await driver.act("fixture", {
            action: "click",
            native_ref: token(observation, "Fixture hosted button"),
            capture_id: observation.capture_id,
            target,
          });
        } catch (error) {
          if (
            !(error instanceof DesktopError) ||
            error.code !== "focus_changed" ||
            error.outcome !== "outcome_unknown"
          )
            throw error;
          phase("guarded uncertain-click recovery");
        }
        phase("effect-receipt");
        const hostedEffect = () =>
          readFile(control + ".hosted-effect", "utf8").then(
            (value) => JSON.parse(value.replace(/^\ufeff/, "")) as { count: number; text: string },
          );
        let observedEffect: { count: number; text: string } | undefined;
        for (let attempt = 0; attempt < 60; attempt++) {
          observedEffect = await hostedEffect().catch(() => undefined);
          if (observedEffect?.count === 1 && observedEffect.text === "cross-process input") break;
          await delay(50);
        }
        assert.deepEqual(
          observedEffect,
          { count: 1, text: "cross-process input" },
          "verify exactly one click effect without replaying an uncertain dispatch",
        );
        phase("after-click-observe");
        observation = await observeHosted();
        assert.equal(observation.is_focused, true);
        assert.equal(
          observation.elements.find((element) => element.label === "Fixture hosted text")?.value,
          "cross-process input",
        );
        const protectedHostedDriver = new WindowsNativeDriver();
        const protectedBefore = process.env.ABRIDGE_PROTECTED_PIDS;
        try {
          phase("protected-driver-start");
          process.env.ABRIDGE_PROTECTED_PIDS = [protectedBefore, String(hostedInfo.pid)]
            .filter(Boolean)
            .join(",");
          try {
            await protectedHostedDriver.diagnostics();
          } finally {
            if (protectedBefore === undefined) delete process.env.ABRIDGE_PROTECTED_PIDS;
            else process.env.ABRIDGE_PROTECTED_PIDS = protectedBefore;
          }
          phase("protected-observe");
          const guarded = await protectedHostedDriver.observe("hosted-protected", target, true);
          phase("protected-rejection");
          await assert.rejects(
            protectedHostedDriver.act("hosted-protected", {
              action: "click",
              native_ref: token(guarded, "Fixture hosted button"),
              capture_id: guarded.capture_id,
              target,
            }),
            { code: "protected_target", outcome: "refused" },
          );
        } finally {
          await protectedHostedDriver.shutdown();
        }
        assert.deepEqual(await hostedEffect(), { count: 1, text: "cross-process input" });
        phase("before-reparent-observe");
        observation = await observe();
        const movedButton = token(observation, "Fixture hosted button");
        phase("reparent");
        await command("hosted-reparent");
        phase("reparent-rejection");
        await assert.rejects(
          driver.act("fixture", {
            action: "click",
            native_ref: movedButton,
            capture_id: observation.capture_id,
            target,
          }),
          { code: "target_changed", outcome: "refused" },
        );
        assert.deepEqual(await hostedEffect(), { count: 1, text: "cross-process input" });
      } catch (error) {
        t.diagnostic(`hosted failure phase: ${hostedPhase}`);
        t.diagnostic(
          `hosted error outcome: ${error instanceof Error && "outcome" in error ? String(error.outcome) : "unavailable"}`,
        );
        await command("state").catch((failure: unknown) =>
          t.diagnostic(`fixture state unavailable: ${String(failure)}`),
        );
        t.diagnostic(`fixture state: ${await readFile(control + ".state", "utf8").catch(() => "missing")}`);
        t.diagnostic(
          `hosted state: ${await readFile(control + ".hosted-state", "utf8").catch(() => "missing")}`,
        );
        const windows = await driver.windows().catch(() => []);
        t.diagnostic(
          JSON.stringify(
            windows
              .filter((entry) => entry.is_focused || entry.pid === fixture.pid || entry.pid === hosted.pid)
              .map((entry) => ({
                pid: entry.pid,
                window_id: entry.window_id,
                focused: entry.is_focused,
                on_screen: entry.is_on_screen,
                bounds: entry.bounds,
              })),
          ),
        );
        t.diagnostic(
          `hosted ready: ${await readFile(control + ".hosted-ready", "utf8").catch(() => "missing")}`,
        );
        if (hostedErrors) t.diagnostic(`hosted stderr: ${hostedErrors}`);
        throw error;
      } finally {
        hosted.kill();
        await hostedClosed;
        await command("hosted-close");
      }
      observation = await observe();
      const sameProcessMovedButton = token(observation, "Fixture deep button");
      await command("same-process-reparent");
      try {
        await assert.rejects(
          driver.act("fixture", {
            action: "click",
            native_ref: sameProcessMovedButton,
            capture_id: observation.capture_id,
            target,
          }),
          { code: "target_changed", outcome: "refused" },
        );
        assert.deepEqual(JSON.parse((await readFile(control + ".deep", "utf8")).replace(/^\ufeff/, "")), {
          count: 1,
          text: "deep fixture input",
        });
      } finally {
        await command("same-process-restore");
      }
      observation = await observe();
      const disabledToken = token(observation, "Record fixture");
      await command("disable");
      await assert.rejects(
        driver.act("fixture", {
          action: "click",
          native_ref: disabledToken,
          capture_id: observation.capture_id,
          target,
        }),
        { code: "stale_element" },
      );
    } catch (error) {
      const windows = await driver.windows().catch(() => []);
      t.diagnostic(
        JSON.stringify({
          failure:
            error instanceof DesktopError
              ? { code: error.code, outcome: error.outcome }
              : { code: "test_failure" },
          window_metadata: windows
            .filter((entry) => entry.is_focused || entry.pid === fixture.pid)
            .map((entry) => ({
              pid: entry.pid,
              window_id: entry.window_id,
              focused: entry.is_focused,
              bounds: entry.bounds,
            })),
        }),
      );
      throw error;
    } finally {
      const fixtureFailure = await readFile(control + ".fixture-error", "utf8").catch(() => "");
      if (fixtureFailure) t.diagnostic(`fixture UI exception: ${fixtureFailure}`);
      if (fixtureErrors) t.diagnostic(`fixture stderr: ${fixtureErrors}`);
      await driver.shutdown();
      fixture.kill();
      await new Promise<void>((r) => (fixture.exitCode !== null ? r() : fixture.once("exit", () => r())));
      await rm(root, { recursive: true, force: true });
    }
  },
);

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const dir = path.resolve(process.argv[2]);
let win;
const results = [];
const errors = [];
app
  .whenReady()
  .then(async () => {
    win = new BrowserWindow({
      show: false,
      width: 393,
      height: 852,
      useContentSize: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("console-message", (event) => {
      console.log("renderer:", event.message);
      if (/Uncaught|Invalid hook|Error:|Unexpected text node/.test(event.message))
        errors.push(event.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const wait = (condition) =>
      js(
        `new Promise((resolve,reject)=>{const start=Date.now();const tick=()=>{if(${condition})resolve(true);else if(Date.now()-start>5000)reject(Error('UI condition timed out: '+${JSON.stringify(condition)}));else setTimeout(tick,25)};tick();})`,
      );
    const load = async (screen) => {
      await win.loadFile(path.join(dir, "ui/index.html"), { query: { screen } });
      await wait(`document.querySelector('#root').textContent.length>15`);
    };
    const screenshot = async (name) =>
      fs.writeFileSync(
        path.join(dir, name + ".png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    for (const screen of ["home", "login", "pair", "remote", "approvals", "rich"]) {
      await load(screen);
      await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      const metrics = await js(
        `({background:getComputedStyle(document.querySelector('#root').firstElementChild).backgroundColor,body:document.body.textContent,overflow:document.documentElement.scrollWidth>innerWidth})`,
      );
      assert(!/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}]/u.test(metrics.body), "emoji on " + screen);
      assert(!metrics.overflow, "horizontal screen overflow on " + screen);
      await screenshot(screen);
      results.push({ screen, overflow: false, noEmoji: true, background: metrics.background });
    }
    await load("chat");
    await wait(`document.querySelector('textarea')`);
    const type = async (value) =>
      js(
        `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    const click = (label) => js(`document.querySelector('[aria-label="${label}"]').click()`);
    await type("Help me plan a focused workday.");
    await click("Send message");
    await wait(`document.body.textContent.includes('Provider unavailable')`);
    await screenshot("chat-failure");
    await js(
      `globalThis.fixtureMode='success';Array.from(document.querySelectorAll('[tabindex="0"]')).find(e=>e.textContent==='Retry').click()`,
    );
    await wait(`globalThis.fixtureSaved.filter(m=>m.role==='assistant').length===1`);
    const retried = await js(
      `({requests:fixtureRequests.map(m=>m.map(x=>x.role)),saved:fixtureSaved.map(m=>m.role),text:document.body.textContent})`,
    );
    assert.deepEqual(retried.requests, [["user"], ["user"]]);
    assert.deepEqual(retried.saved, ["user", "assistant"]);
    assert(!retried.text.includes("Provider unavailable"));
    await screenshot("chat-success");
    results.push({ retryNoDuplicateUser: true, failedRowRetired: true });
    await js(`globalThis.fixtureMode='stop'`);
    await type("One more question");
    await click("Send message");
    await wait(
      `document.querySelector('[aria-label="Stop response"]') && fixtureRequests.length===3`,
    );
    await click("Stop response");
    await wait(`document.querySelector('[aria-label="Send message"]') && fixtureSaved.length===4`);
    assert.deepEqual(await js("fixtureSaved.map(m=>m.role)"), [
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    results.push({ stopSettled: true, partialSaved: true });
    await load("pair");
    const clickText = (text) =>
      js(
        `Array.from(document.querySelectorAll('[tabindex="0"]')).find(e=>e.textContent===${JSON.stringify(text)}).click()`,
      );
    await clickText("Paste pairing details");
    await wait(`document.querySelector('textarea')`);
    await type("fixture advertisement; inert parser in preview only");
    await clickText("Continue");
    await wait(`document.body.textContent.includes('Pair with this device')`);
    await clickText("Pair with this device");
    await wait(`document.body.textContent.includes('Connecting to your Mac')`);
    assert.equal(
      await js(`document.body.textContent.includes('Waiting for desktop approval')`),
      false,
    );
    await screenshot("pair-connecting");
    results.push({ preHandshakeShowsConnection: true, noFalseApproval: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(dir, "ui-result.json"),
      JSON.stringify(
        {
          renderer:
            "actual React Native Web screens; inert account/transport fixtures; not iPhone native",
          results,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(results));
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });

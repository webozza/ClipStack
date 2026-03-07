const feedEl = document.getElementById("feed");
const clearBtn = document.getElementById("clearBtn");

let state = { items: [], pinnedKeys: [], settings: {} };

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function isPinned(key) {
  return (state.pinnedKeys || []).includes(key);
}

function render() {
  const items = state.items || [];
  feedEl.innerHTML = "";

  if (!items.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No clipboard items yet. Copy something in any app, then open this app.";
    feedEl.appendChild(div);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";

    const top = document.createElement("div");
    top.className = "cardTop";

    const meta = document.createElement("div");
    meta.className = "meta";

    const b1 = document.createElement("span");
    b1.className = "badge";
    b1.textContent = (item.type || "text").toUpperCase();

    const b2 = document.createElement("span");
    b2.className = "badge";
    b2.textContent = timeAgo(item.ts);

    const b3 = document.createElement("span");
    b3.className = "badge";
    b3.textContent = fmtDate(item.ts);

    meta.appendChild(b1);
    meta.appendChild(b2);
    meta.appendChild(b3);

    if (isPinned(item.key)) {
      const pin = document.createElement("span");
      pin.className = "badge";
      pin.textContent = "PINNED";
      meta.appendChild(pin);
    }

    const right = document.createElement("div");
    right.className = "meta";
    const size = document.createElement("span");
    size.className = "badge";
    size.textContent = `${(item.value || "").length} chars`;
    right.appendChild(size);

    top.appendChild(meta);
    top.appendChild(right);

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = item.value || "";

    const actions = document.createElement("div");
    actions.className = "cardActions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "smallBtn";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = async () => {
      // This uses your existing main.js handler (copies to clipboard)
      await window.clipAPI.selectItem(item.key, "copy");
      // NOTE: if your main.js hides window on select, it may hide after copying.
      // If you don’t want that, remove `win.hide()` inside item:select in main.js.
    };

    const pinBtn = document.createElement("button");
    pinBtn.className = "smallBtn";
    pinBtn.textContent = isPinned(item.key) ? "Unpin" : "Pin";
    pinBtn.onclick = async () => {
      await window.clipAPI.togglePin(item.key);
    };

    const delBtn = document.createElement("button");
    delBtn.className = "smallBtn";
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
      await window.clipAPI.deleteItem(item.key);
    };

    actions.appendChild(copyBtn);
    actions.appendChild(pinBtn);
    actions.appendChild(delBtn);

    card.appendChild(top);
    card.appendChild(body);
    card.appendChild(actions);

    frag.appendChild(card);
  }

  feedEl.appendChild(frag);
}

clearBtn.addEventListener("click", async () => {
  const ok = confirm("Clear all clipboard history?");
  if (ok) await window.clipAPI.clearHistory();
});

async function init() {

  state = await window.clipAPI.getState();
  render();

  window.clipAPI.onState((next) => {
    state = next;
    render();
  });
}

init();
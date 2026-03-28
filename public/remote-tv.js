const remoteForm = document.getElementById("remote-form");
const remoteUrlInput = document.getElementById("remote-url");
const remoteCodeEl = document.getElementById("remote-code");
const remoteStatusEl = document.getElementById("remote-status");
const copyCodeButton = document.getElementById("copy-code-button");
const newCodeButton = document.getElementById("new-code-button");

let latestCode = "";

function setRemoteStatus(message, isError = false) {
  remoteStatusEl.textContent = message;
  remoteStatusEl.classList.toggle("is-error", isError);
}

function setResultMode(isResultMode) {
  remoteForm.classList.toggle("hidden", isResultMode);
  newCodeButton.classList.toggle("hidden", !isResultMode);
}

remoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = remoteUrlInput.value.trim();
  if (!url) {
    setRemoteStatus("Paste a Google Drive folder link to get started.", true);
    return;
  }

  try {
    setRemoteStatus("Creating your pairing code...");

    const response = await fetch("/api/remote/link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save link.");
    }

    latestCode = data.code;
    remoteCodeEl.textContent = data.code;
    setResultMode(true);
    setRemoteStatus(`You’re all set. Enter ${data.code} on your TV to continue.`);
    remoteForm.reset();
  } catch (error) {
    setRemoteStatus(error.message, true);
  }
});

copyCodeButton.addEventListener("click", async () => {
  if (!latestCode) {
    setRemoteStatus("Create a code first, then you can copy it.", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(latestCode);
    setRemoteStatus(`Copied ${latestCode}.`);
  } catch (error) {
    setRemoteStatus("We couldn’t copy it automatically, so please copy it manually.", true);
  }
});

newCodeButton.addEventListener("click", () => {
  latestCode = "";
  remoteCodeEl.textContent = "------";
  setResultMode(false);
  setRemoteStatus("Paste another Google Drive link whenever you're ready.");
  remoteUrlInput.focus();
});

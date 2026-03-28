const remoteForm = document.getElementById("remote-form");
const remoteUrlInput = document.getElementById("remote-url");
const remoteCodeEl = document.getElementById("remote-code");
const remoteStatusEl = document.getElementById("remote-status");
const remoteResultPanel = document.querySelector(".remote-result");
const shareCodeButton = document.getElementById("share-code-button");
const copyCodeButton = document.getElementById("copy-code-button");
const newCodeButton = document.getElementById("new-code-button");
const deleteModeButton = document.getElementById("delete-mode-button");
const cancelDeleteButton = document.getElementById("cancel-delete-button");
const deleteForm = document.getElementById("remote-delete-form");
const deleteCodeInput = document.getElementById("delete-code");
const deleteUrlInput = document.getElementById("delete-url");
const permanentCheckbox = document.getElementById("remote-permanent");

let latestCode = "";
let latestFolderName = "";
let isDeleteMode = false;

function buildShareMessage() {
  const folderName = latestFolderName || "Google Drive folder";
  return `Your DriveDeck pairing code for ${folderName} is *${latestCode}*`;
}

function setRemoteStatus(message, isError = false) {
  remoteStatusEl.textContent = message;
  remoteStatusEl.style.color = isError ? "#ffb4ac" : "";
}

function setResultMode(isResultMode) {
  remoteForm.classList.toggle("hidden", isResultMode);
  newCodeButton.classList.toggle("hidden", !isResultMode);
  remoteResultPanel.classList.toggle("hidden", !isResultMode || isDeleteMode);
}

function setDeleteMode(enabled) {
  isDeleteMode = enabled;
  remoteForm.classList.toggle("hidden", enabled);
  deleteForm.classList.toggle("hidden", !enabled);
  deleteModeButton.classList.toggle("hidden", enabled);
  cancelDeleteButton.classList.toggle("hidden", !enabled);
  newCodeButton.classList.toggle("hidden", enabled || !latestCode);
  remoteResultPanel.classList.toggle("hidden", enabled || !latestCode);

  if (enabled) {
    setRemoteStatus("Enter the code and original Drive link to delete it.");
    deleteCodeInput.focus();
  } else {
    setRemoteStatus(latestCode ? `All set. Enter code ${latestCode} on the TV to continue.` : "Paste another Google Drive link whenever you're ready.");
    remoteUrlInput.focus();
  }
}

remoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = remoteUrlInput.value.trim();
  const permanent = permanentCheckbox.checked;
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
      body: JSON.stringify({ url, permanent }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save link.");
    }

    latestCode = data.code;
    latestFolderName = data.folderName || "Google Drive folder";
    remoteCodeEl.textContent = data.code;
    setResultMode(true);
    deleteModeButton.classList.remove("hidden");
    setRemoteStatus(`All set. Enter code ${data.code} on the TV to continue.`);
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
    setRemoteStatus(`Code ${latestCode} copied.`);
  } catch (error) {
    setRemoteStatus("We couldn’t copy it automatically, so please copy it manually.", true);
  }
});

shareCodeButton.addEventListener("click", async () => {
  if (!latestCode) {
    setRemoteStatus("Create a code first, then you can share it.", true);
    return;
  }

  const message = buildShareMessage();
  try {
    if (navigator.share) {
      await navigator.share({ text: message });
      setRemoteStatus("Share sheet opened.");
      return;
    }

    await navigator.clipboard.writeText(message);
    setRemoteStatus("Sharing is not available here, so we copied the message instead.");
  } catch (error) {
    setRemoteStatus("We couldn’t open sharing right now.", true);
  }
});

newCodeButton.addEventListener("click", () => {
  latestCode = "";
  latestFolderName = "";
  remoteCodeEl.textContent = "---------";
  setResultMode(false);
  deleteModeButton.classList.remove("hidden");
  setRemoteStatus("Paste another Google Drive link whenever you're ready.");
  remoteUrlInput.focus();
});

deleteModeButton.addEventListener("click", () => {
  setDeleteMode(true);
});

cancelDeleteButton.addEventListener("click", () => {
  deleteForm.reset();
  setDeleteMode(false);
});

deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = deleteCodeInput.value.trim();
  const url = deleteUrlInput.value.trim();
  if (!code || !url) {
    setRemoteStatus("Enter the code and original Google Drive link to continue.", true);
    return;
  }

  try {
    setRemoteStatus("Deleting code...");
    const response = await fetch("/api/remote/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code, url }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not delete code.");
    }

    deleteForm.reset();
    if (latestCode === code) {
      latestCode = "";
      latestFolderName = "";
      remoteCodeEl.textContent = "---------";
      setResultMode(false);
    }
    setDeleteMode(false);
    setRemoteStatus("Code deleted.");
  } catch (error) {
    setRemoteStatus(error.message, true);
  }
});

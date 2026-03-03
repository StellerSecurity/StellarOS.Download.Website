// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import * as fastboot from "./fastboot/ffe7e270/fastboot.min.mjs";

const RELEASES_URL = "https://stellar-releases.dk";


const Buttons = {
    UNLOCK_BOOTLOADER: "unlock-bootloader",
    DOWNLOAD_RELEASE: "download-release",
    FLASH_RELEASE: "flash-release",
    LOCK_BOOTLOADER: "lock-bootloader",
    REMOVE_CUSTOM_KEY: "remove-custom-key"
};

const InstallerState = {
    DOWNLOADING_RELEASE: 0x1,
    INSTALLING_RELEASE: 0x2
};

let wakeLock = null;

const requestWakeLock = async () => {
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        console.log("Wake lock has been set");
        wakeLock.addEventListener("release", async () => {
            console.log("Wake lock has been released");
        });
    } catch (err) {
        // If wake lock request fails - usually system related, such as battery
        throw new Error(`${err.name}, ${err.message}`);
    }
};

const releaseWakeLock = async () => {
    if (wakeLock !== null) {
        wakeLock.release().then(() => {
            wakeLock = null;
        });
    }
};

// Reacquire wake lock should the visibility of the document change and the wake lock is released
document.addEventListener("visibilitychange", async () => {
    if (wakeLock !== null && document.visibilityState === "visible") {
        await requestWakeLock();
    }
});

// This wraps XHR because getting progress updates with fetch() is overly complicated.
function fetchBlobWithProgress(url, onProgress) {
    let xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.send();

    return new Promise((resolve, reject) => {
        xhr.onload = () => {
            if (xhr.status !== 200) {
                reject(`${xhr.status} ${xhr.statusText}`);
            } else {
                resolve(xhr.response);
            }
        };
        xhr.onprogress = (event) => {
            // event.total can be 0 or undefined in some cases
            if (event.total) {
                onProgress(event.loaded / event.total);
            }
        };
        xhr.onerror = () => {
            // onerror is called on network errors
            reject("Network request failed");
        };
    });
}

async function getContentLength(url) {
    try {
        const resp = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (!resp.ok) return null;
        const len = resp.headers.get("content-length");
        if (!len) return null;
        const n = Number(len);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

// Minimal ZIP integrity check to catch truncated/corrupt downloads before unzip/flash.
async function validateZipBlob(blob) {
    const size = blob.size;
    if (!Number.isFinite(size) || size < 1024) {
        throw new Error("downloaded ZIP is unexpectedly small; please retry the download");
    }

    // EOCD is within the last 65,557 bytes (64k + comment + header).
    const tailLen = Math.min(size, 65557);
    const tail = new Uint8Array(await blob.slice(size - tailLen, size).arrayBuffer());

    // EOCD signature: 0x06054b50 (little-endian: 50 4b 05 06)
    let eocdOffset = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error("ZIP appears to be corrupt/truncated (EOCD not found). Re-download and try again.");
    }

    const dv = new DataView(tail.buffer, tail.byteOffset + eocdOffset, tail.length - eocdOffset);
    const cdSize = dv.getUint32(12, true);
    const cdOffset = dv.getUint32(16, true);

    // Zip64 uses sentinel values; we don't fully parse Zip64 here, but at least avoid false negatives.
    const isZip64 = (cdSize === 0xffffffff || cdOffset === 0xffffffff);
    if (!isZip64) {
        const cdEnd = cdOffset + cdSize;
        if (cdEnd > size) {
            throw new Error("ZIP appears truncated (central directory beyond file end). Re-download and try again.");
        }
    }
}

async function downloadFreshBlob(url, onProgress) {
    // Cache-buster to avoid intermediaries reusing partial downloads.
    const cacheBuster = url.includes("?") ? "&" : "?";
    const freshUrl = `${url}${cacheBuster}ts=${Date.now()}`;

    const expected = await getContentLength(url);
    const blob = await fetchBlobWithProgress(freshUrl, onProgress);

    if (expected !== null && blob.size !== expected) {
        throw new Error(`download size mismatch (expected ${expected} bytes, got ${blob.size} bytes). Please retry.`);
    }

    await validateZipBlob(blob);
    return blob;
}

function setButtonState({ id, enabled }) {
    const button = document.getElementById(`${id}-button`);
    if (!button) {
        console.warn(`[web-install] Missing button element: #${id}-button`);
        return null;
    }
    button.disabled = !enabled;
    return button;
}


class ButtonController {
    #map;

    constructor() {
        this.#map = new Map();
    }

    setEnabled(...ids) {
        ids.forEach((id) => {
            // Only enable button if it won't be disabled.
            if (!this.#map.has(id)) {
                this.#map.set(id, /* enabled = */ true);
            }
        });
    }

    setDisabled(...ids) {
        ids.forEach((id) => this.#map.set(id, /* enabled = */ false));
    }

    applyState() {
        this.#map.forEach((enabled, id) => {
            setButtonState({ id, enabled });
        });
        this.#map.clear();
    }
}

let installerState = 0;

let device = new fastboot.FastbootDevice();
let downloadedRelease = null; // { name: string, blob: Blob, product: string, releaseId: string, downloadedAt: number }
let buttonController = new ButtonController();

async function ensureConnected(setProgress) {
    if (!device.isConnected) {
        setProgress("Connecting to device...");
        await device.connect();
    }
}

async function unlockBootloader(setProgress) {
    await ensureConnected(setProgress);

    // Trying to unlock when the bootloader is already unlocked results in a FAIL,
    // so don't try to do it.
    if (await device.getVariable("unlocked") === "yes") {
        return "Bootloader is already unlocked.";
    }

    setProgress("Unlocking bootloader...");
    try {
        await device.runCommand("flashing unlock");
    } catch (error) {
        // FAIL = user rejected unlock
        if (error instanceof fastboot.FastbootError && error.status === "FAIL") {
            throw new Error("Bootloader was not unlocked, please try again!");
        } else {
            throw error;
        }
    }

    return "Bootloader unlocking triggered successfully.";
}

const supportedDevices = [
    "rango", "mustang", "blazer", "frankel", "tegu", "comet", "komodo", "caiman", "tokay",
    "akita", "husky", "shiba", "felix", "tangorpro", "lynx", "cheetah", "panther", "bluejay",
    "raven", "oriole", "barbet", "redfin", "bramble", "sunfish", "coral", "flame"
];

const legacyQualcommDevices = ["sunfish", "coral", "flame"];

const day1SnapshotCancelDevices = [
    "tegu", "comet", "komodo", "caiman", "tokay", "akita", "husky", "shiba", "felix",
    "tangorpro", "lynx", "cheetah", "panther", "bluejay", "raven", "oriole", "barbet",
    "redfin", "bramble"
];

function hasOptimizedFactoryImage(product) {
    return !legacyQualcommDevices.includes(product);
}

async function getLatestRelease() {
    let product = await device.getVariable("product");
    if (!supportedDevices.includes(product)) {
        throw new Error(`device model (${product}) is not supported by the StellarOS web installer`);
    }

    const base = RELEASES_URL.replace(/\/+$/, "");
    let metadataResp = await fetch(`${base}/${product}-stable`, { cache: "no-store" });
    if (!metadataResp.ok) {
        throw new Error(`failed to fetch release metadata for ${product} (HTTP ${metadataResp.status})`);
    }

    let metadata = await metadataResp.text();
    let releaseId = metadata.trim().split(/\s+/)[0];

    // Older Stellar releases publish factory images only.
    return [`${product}-factory-${releaseId}.zip`, product, releaseId];
}

async function downloadRelease(setProgress) {
    await requestWakeLock();
    await ensureConnected(setProgress);

    setProgress("Finding latest release...");
    let [latestZip, product, releaseId] = await getLatestRelease();

    setInstallerState({ state: InstallerState.DOWNLOADING_RELEASE, active: true });
    try {
        const base = RELEASES_URL.replace(/\/+$/, "");
        const url = `${base}/${latestZip}`;
        setProgress(`Downloading ${latestZip}...`, 0);
        const blob = await downloadFreshBlob(url, (progress) => {
            setProgress(`Downloading ${latestZip}...`, progress);
        });

        downloadedRelease = { name: latestZip, blob, product, releaseId, downloadedAt: Date.now() };
        setProgress(`Downloaded ${latestZip} release.`, 1.0);
    } finally {
        setInstallerState({ state: InstallerState.DOWNLOADING_RELEASE, active: false });
        await releaseWakeLock();
    }
}

async function reconnectCallback() {
    let statusField = document.getElementById("flash-release-status");
    if (statusField) {
        statusField.textContent = "To continue flashing, reconnect the device by tapping here:";
    }

    let reconnectButton = document.getElementById("flash-reconnect-button");
    let progressBar = document.getElementById("flash-release-progress");

    if (!reconnectButton || !progressBar) return;

    // Hide progress bar while waiting for reconnection
    progressBar.hidden = true;
    reconnectButton.hidden = false;

    reconnectButton.onclick = async () => {
        await device.connect();
        reconnectButton.hidden = true;
        progressBar.hidden = false;
    };
}

async function flashRelease(setProgress) {
    await requestWakeLock();
    await ensureConnected(setProgress);

    setProgress("Finding latest release...");
    let [latestZip, product, releaseId] = await getLatestRelease();

    let blob;
    if (downloadedRelease !== null && downloadedRelease.name === latestZip) {
        blob = downloadedRelease.blob;
    } else {
        // Download the exact ZIP we are about to flash (fresh download, no persistent caching).
        setInstallerState({ state: InstallerState.DOWNLOADING_RELEASE, active: true });
        try {
            const base = RELEASES_URL.replace(/\/+$/, "");
            const url = `${base}/${latestZip}`;
            setProgress(`Downloading ${latestZip}...`, 0);
            blob = await downloadFreshBlob(url, (progress) => {
                setProgress(`Downloading ${latestZip}...`, progress);
            });

            downloadedRelease = { name: latestZip, blob, product, releaseId, downloadedAt: Date.now() };
        } finally {
            setInstallerState({ state: InstallerState.DOWNLOADING_RELEASE, active: false });
        }
    }
    if (!blob) {
        throw new Error("failed to obtain release ZIP; please retry");
    }

    setProgress("Cancelling any pending OTAs...");
    // Cancel snapshot update if in progress on devices which support it on all bootloader versions
    if (day1SnapshotCancelDevices.includes(product)) {
        let snapshotStatus = await device.getVariable("snapshot-update-status");
        if (snapshotStatus !== null && snapshotStatus !== "none") {
            await device.runCommand("snapshot-update:cancel");
        }
    }

    setProgress("Flashing release...");
    setInstallerState({ state: InstallerState.INSTALLING_RELEASE, active: true });

    // Watchdog: if unzip/flash stalls, surface a clear error instead of hanging forever.
    let stallTimer = null;
    let stallReject = null;
    const stallPromise = new Promise((_, reject) => { stallReject = reject; });

    const resetStall = (label) => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            stallReject(new Error(`stalled while ${label}. This usually means a corrupt/truncated ZIP. Please re-download and try again.`));
        }, 180000); // 3 minutes
    };

    try {
        resetStall("preparing the flash");
        const flashPromise = device.flashFactoryZip(blob, true, reconnectCallback, (action, item, progress) => {
            let userAction = fastboot.USER_ACTION_MAP[action];
            let userItem = item === "avb_custom_key" ? "verified boot key" : item;
            setProgress(`${userAction} ${userItem}...`, progress);

            if (action === "unpack") resetStall(`unpacking ${userItem}`);
            if (action === "flash") resetStall(`writing ${userItem}`);
        });

        await Promise.race([flashPromise, stallPromise]);

        if (legacyQualcommDevices.includes(product)) {
            setProgress("Disabling UART...");
            // See https://android.googlesource.com/platform/system/core/+/eclair-release/fastboot/fastboot.c#532
            // for context as to why the trailing space is needed.
            await device.runCommand("oem uart disable ");
            setProgress("Erasing apdp...");
            // Both slots are wiped as even apdp on an inactive slot will modify /proc/cmdline
            await device.runCommand("erase:apdp_a");
            await device.runCommand("erase:apdp_b");
            setProgress("Erasing msadp...");
            await device.runCommand("erase:msadp_a");
            await device.runCommand("erase:msadp_b");
        }
    } finally {
        if (stallTimer) clearTimeout(stallTimer);
        setInstallerState({ state: InstallerState.INSTALLING_RELEASE, active: false });
        await releaseWakeLock();
    }

    return `Flashed ${latestZip} to device.`;
}

async function eraseNonStockKey(setProgress) {
    await ensureConnected(setProgress);

    setProgress("Erasing key...");
    try {
        await device.runCommand("erase:avb_custom_key");
    } catch (error) {
        console.log(error);
        throw error;
    }
    return "Key erased.";
}

async function lockBootloader(setProgress) {
    await ensureConnected(setProgress);

    setProgress("Locking bootloader...");
    try {
        await device.runCommand("flashing lock");
    } catch (error) {
        // FAIL = user rejected lock
        if (error instanceof fastboot.FastbootError && error.status === "FAIL") {
            throw new Error("Bootloader was not locked, please try again!");
        } else {
            throw error;
        }
    }

    return "Bootloader locking triggered successfully.";
}

function addButtonHook(id, callback) {
    const button = setButtonState({ id, enabled: true });
    if (!button) {
        // Button not present in HTML, silently skip.
        return;
    }

    let statusContainer = document.getElementById(`${id}-status-container`);
    let statusField = document.getElementById(`${id}-status`);
    let progressBar = document.getElementById(`${id}-progress`);

    let statusCallback = (status, progress) => {
        if (statusContainer !== null) {
            statusContainer.hidden = false;
        }

        if (statusField !== null) {
            statusField.className = "";
            statusField.textContent = status;
        } else {
            console.warn(`[web-install] Missing status field: #${id}-status`);
        }

        if (progress !== undefined && progressBar !== null) {
            progressBar.hidden = false;
            progressBar.value = progress;
        }
    };

    button.onclick = async () => {
        try {
            let finalStatus = await callback(statusCallback);
            if (finalStatus !== undefined) {
                statusCallback(finalStatus);
            }
        } catch (error) {
            let errorMessage;
            if (error instanceof DOMException && error.name === "QuotaExceededError") {
                // Provide a more descriptive message than "Error: QuotaExceededError"
                errorMessage = "storage quota has been exceeded, you might not have enough space on your drive, or you're using incognito mode";
            } else if (typeof (error) === "object" && error.message != null && error.message !== "") {
                errorMessage = error.message;
            } else {
                // Sometimes non-error objects are thrown
                errorMessage = error.toString();
            }

            statusCallback(`Error: ${errorMessage}`);
            if (statusField !== null) {
                statusField.className = "error-text";
            }

            await releaseWakeLock();
            // Rethrow the error so it shows up in the console
            throw error;
        }
    };
}

function setInstallerState({ state, active }) {
    if (active) {
        installerState |= state;
    } else {
        installerState &= ~state;
    }
    invalidateInstallerState();
}

function isInstallerStateActive(state) {
    return (installerState & state) === state;
}

function invalidateInstallerState() {
    if (isInstallerStateActive(InstallerState.DOWNLOADING_RELEASE)) {
        buttonController.setDisabled(Buttons.DOWNLOAD_RELEASE);
    } else {
        buttonController.setEnabled(Buttons.DOWNLOAD_RELEASE);
    }

    let disableWhileInstalling = [
        Buttons.DOWNLOAD_RELEASE,
        Buttons.FLASH_RELEASE,
        Buttons.LOCK_BOOTLOADER,
        Buttons.REMOVE_CUSTOM_KEY,
    ];

    if (isInstallerStateActive(InstallerState.INSTALLING_RELEASE)) {
        buttonController.setDisabled(...disableWhileInstalling);
    } else {
        buttonController.setEnabled(...disableWhileInstalling);
    }

    buttonController.applyState();
}

function safeToLeave() {
    return installerState === 0;
}

// This doesn't really hurt, and because this page is exclusively for web install,
// we can tolerate extra logging in the console in case something goes wrong.
fastboot.setDebugLevel(2);

fastboot.configureZip({
    // Prefer stability over speed. This avoids "Unpacking ... stuck forever" issues in some environments.
    useWebWorkers: false,
    workerScripts: {
        inflate: ["/js/fastboot/ffe7e270/vendor/z-worker-pako.js", "pako_inflate.min.js"],
    },
});

if ("usb" in navigator) {
    addButtonHook(Buttons.UNLOCK_BOOTLOADER, unlockBootloader);
    addButtonHook(Buttons.DOWNLOAD_RELEASE, downloadRelease);
    addButtonHook(Buttons.FLASH_RELEASE, flashRelease);
    addButtonHook(Buttons.LOCK_BOOTLOADER, lockBootloader);
    addButtonHook(Buttons.REMOVE_CUSTOM_KEY, eraseNonStockKey);

    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(estimate => {
            // Currently factory images are ~1700MiB
            // Show a warning if the estimated space is below 2000MiB
            if (estimate.quota !== 0 && estimate.quota < 2000 * 1024 * 1024) {
                const warning = document.getElementById("quota-warning-text");
                if (warning) {
                    warning.hidden = false;
                } else {
                    console.warn("[web-install] Missing #quota-warning-text");
                }
            }
        });
    }
} else {
    console.log("WebUSB unavailable");
    for (const btnId in Buttons) {
        const elementId = Buttons[btnId];

        const statusContainer = document.getElementById(`${elementId}-status-container`);
        const statusField = document.getElementById(`${elementId}-status`);

        if (statusContainer !== null) {
            statusContainer.hidden = false;
        }
        if (statusField !== null) {
            statusField.className = "error-text";
            statusField.innerHTML = "Unavailable, as your browser doesn't support WebUSB. Please read the <a href=\"#prerequisites\">prerequisites</a>.";
        } else {
            console.warn(`[web-install] Missing status field: #${elementId}-status`);
        }
    }
}

// This will create an alert box to stop the user from leaving the page during actions
window.addEventListener("beforeunload", event => {
    if (!safeToLeave()) {
        console.log("User tried to leave the page whilst unsafe to leave!");
        event.returnValue = "";
    }
});

// @license-end
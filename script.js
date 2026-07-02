const MAX_FILES = 50;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const AI_MODEL = 'large';
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const state = {
  results: [],
  selectedCount: 0,
  finishedCount: 0,
  bytesHeld: 0,
  busy: false
};

const elements = {
  fileInput: document.getElementById('fileInput'),
  dropZone: document.getElementById('dropZone'),
  results: document.getElementById('results'),
  selectedCount: document.getElementById('selectedCount'),
  finishedCount: document.getElementById('finishedCount'),
  memoryLabel: document.getElementById('memoryLabel'),
  progressWrap: document.getElementById('progressWrap'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  progressBar: document.getElementById('progressBar'),
  batchToolbar: document.getElementById('batchToolbar'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  resetBtn: document.getElementById('resetBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  toast: document.getElementById('toast')
};

let removeBackgroundPromise;
let toastTimer;

elements.fileInput.addEventListener('change', function(event) {
  handleFiles(event.target.files);
});

elements.dropZone.addEventListener('click', function(event) {
  event.preventDefault();
  openFilePicker();
});

elements.dropZone.addEventListener('keydown', function(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openFilePicker();
  }
});

elements.dropZone.addEventListener('dragover', function(event) {
  event.preventDefault();
  elements.dropZone.classList.add('dragover');
});

elements.dropZone.addEventListener('dragleave', function() {
  elements.dropZone.classList.remove('dragover');
});

elements.dropZone.addEventListener('drop', function(event) {
  event.preventDefault();
  elements.dropZone.classList.remove('dragover');
  handleFiles(event.dataTransfer.files);
});

elements.downloadAllBtn.addEventListener('click', downloadAll);
elements.resetBtn.addEventListener('click', clearWorkspace);
elements.clearCacheBtn.addEventListener('click', async function() {
  await clearWorkspaceCache();
  showToast('Workspace cache cleared');
});

renderStatus();

function openFilePicker() {
  if (state.busy) {
    showToast('Please wait for the current batch to finish.', 'warning');
    return;
  }

  elements.fileInput.click();
}

async function loadBackgroundRemoval() {
  if (!removeBackgroundPromise) {
    removeBackgroundPromise = import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm')
      .then(function(module) {
        if (!module.removeBackground) {
          throw new Error('Background removal function not found.');
        }
        return module.removeBackground;
      });
  }

  return removeBackgroundPromise;
}

async function handleFiles(fileList) {
  if (state.busy) {
    showToast('Please wait for the current batch to finish.', 'warning');
    return;
  }

  const files = Array.from(fileList || []);
  if (!files.length) return;

  const validation = validateFiles(files);
  if (validation.rejected.length) {
    showToast(validation.rejected[0], 'warning');
  }

  if (!validation.valid.length) {
    elements.fileInput.value = '';
    return;
  }

  clearWorkspace({ silent: true });
  state.busy = true;
  state.selectedCount = validation.valid.length;
  state.finishedCount = 0;
  renderStatus();
  setProgress(0, 'Loading high quality AI background remover...');

  try {
    const removeBackground = await loadBackgroundRemoval();

    for (let index = 0; index < validation.valid.length; index += 1) {
      const file = validation.valid[index];
      const batchProgress = Math.round((index / validation.valid.length) * 100);
      setProgress(batchProgress, `Processing ${index + 1} of ${validation.valid.length}: ${file.name}`);
      await processFile(file, removeBackground);
    }

    setProgress(100, 'Batch complete');
    elements.batchToolbar.hidden = state.results.length === 0;
    showToast(`Processed ${state.results.length} image${state.results.length === 1 ? '' : 's'}.`);
  } catch (error) {
    console.error(error);
    showToast('The AI background remover could not load or process this batch. Try refreshing or using Chrome/Edge.', 'error');
  } finally {
    state.busy = false;
    elements.fileInput.value = '';
    renderStatus();
  }
}

function validateFiles(files) {
  const rejected = [];
  const valid = [];

  if (files.length > MAX_FILES) {
    rejected.push(`Only the first ${MAX_FILES} images were accepted.`);
  }

  files.slice(0, MAX_FILES).forEach(function(file) {
    if (!ALLOWED_TYPES.has(file.type)) {
      rejected.push(`${file.name} was skipped because it is not JPG, PNG, or WebP.`);
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      rejected.push(`${file.name} was skipped because it is larger than 20 MB.`);
      return;
    }

    valid.push(file);
  });

  return { valid, rejected };
}

async function processFile(file, removeBackground) {
  const startedAt = performance.now();
  const originalUrl = URL.createObjectURL(file);
  let resultBlob;

  try {
    resultBlob = await removeBackground(file, {
      model: AI_MODEL,
      output: {
        format: 'image/png',
        quality: 1
      },
      progress: function(_key, current, total) {
        if (!total) return;
        const fileShare = current / total;
        const completedShare = state.finishedCount / state.selectedCount;
        const totalProgress = Math.round((completedShare + fileShare / state.selectedCount) * 100);
        setProgress(totalProgress, `Removing background from ${file.name}`);
      }
    });
  } catch (error) {
    URL.revokeObjectURL(originalUrl);
    throw error;
  }

  const resultUrl = URL.createObjectURL(resultBlob);
  const result = {
    id: createId(),
    fileName: file.name,
    outputName: createOutputName(file.name),
    size: file.size + resultBlob.size,
    originalUrl,
    resultUrl,
    resultBlob,
    durationMs: Math.round(performance.now() - startedAt),
    downloaded: false
  };

  state.results.push(result);
  state.finishedCount += 1;
  state.bytesHeld += result.size;
  renderResult(result);
  renderStatus();
}

function renderResult(result) {
  const card = document.createElement('article');
  card.className = 'result-card';
  card.dataset.resultId = result.id;

  const preview = document.createElement('div');
  preview.className = 'result-preview';

  const originalPane = document.createElement('div');
  originalPane.className = 'preview-pane';
  const originalImg = document.createElement('img');
  originalImg.src = result.originalUrl;
  originalImg.alt = `Original ${result.fileName}`;
  originalPane.appendChild(originalImg);

  const resultPane = document.createElement('div');
  resultPane.className = 'preview-pane';
  const resultImg = document.createElement('img');
  resultImg.src = result.resultUrl;
  resultImg.alt = `Background removed ${result.fileName}`;
  resultPane.appendChild(resultImg);

  preview.append(originalPane, resultPane);

  const body = document.createElement('div');
  body.className = 'result-body';

  const title = document.createElement('div');
  title.className = 'result-title';
  title.textContent = result.fileName;

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  meta.textContent = `${formatBytes(result.resultBlob.size)} PNG generated in ${(result.durationMs / 1000).toFixed(1)}s`;

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  const downloadButton = document.createElement('button');
  downloadButton.className = 'button primary';
  downloadButton.type = 'button';
  downloadButton.textContent = 'Download PNG';
  downloadButton.addEventListener('click', function() {
    downloadSingle(result.id);
  });

  const clearButton = document.createElement('button');
  clearButton.className = 'button secondary';
  clearButton.type = 'button';
  clearButton.textContent = 'Clear';
  clearButton.addEventListener('click', function() {
    releaseResult(result.id);
    showToast('Temporary image cleared.');
  });

  actions.append(downloadButton, clearButton);
  body.append(title, meta, actions);
  card.append(preview, body);
  elements.results.appendChild(card);
}

function renderStatus() {
  elements.selectedCount.textContent = `${state.selectedCount} / ${MAX_FILES}`;
  elements.finishedCount.textContent = String(state.finishedCount);
  elements.memoryLabel.textContent = state.bytesHeld > 0 ? formatBytes(state.bytesHeld) : 'Empty';
  elements.clearCacheBtn.disabled = state.busy || state.results.length === 0;
  elements.resetBtn.disabled = state.busy;
  elements.downloadAllBtn.disabled = state.busy || state.results.length === 0;
}

function setProgress(percent, text) {
  const safePercent = Math.max(0, Math.min(100, percent));
  elements.progressWrap.hidden = false;
  elements.progressText.textContent = text;
  elements.progressPercent.textContent = `${safePercent}%`;
  elements.progressBar.style.width = `${safePercent}%`;
}

function downloadSingle(id) {
  const result = state.results.find(function(item) {
    return item.id === id;
  });

  if (!result) return;

  saveBlob(result.resultBlob, result.outputName);
  releaseResult(id);
  showToast('Downloaded and temporary cache cleared.');
}

async function downloadAll() {
  if (!state.results.length || state.busy) return;

  try {
    if (state.results.length === 1) {
      downloadSingle(state.results[0].id);
      return;
    }

    if (!window.JSZip) {
      throw new Error('JSZip is not loaded.');
    }

    const zip = new window.JSZip();
    state.results.forEach(function(result) {
      zip.file(result.outputName, result.resultBlob);
    });

    setProgress(100, 'Creating ZIP archive...');
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    saveBlob(zipBlob, 'pixelcutpro-background-removed-images.zip');
    clearWorkspace({ silent: true });
    await clearBrowserCacheStorage();
    showToast('ZIP downloaded and temporary cache cleared.');
  } catch (error) {
    console.error(error);
    showToast('ZIP download failed. Try downloading files one by one.', 'error');
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(function() {
    URL.revokeObjectURL(url);
  }, 1500);
}

function releaseResult(id) {
  const index = state.results.findIndex(function(item) {
    return item.id === id;
  });

  if (index === -1) return;

  const [result] = state.results.splice(index, 1);
  URL.revokeObjectURL(result.originalUrl);
  URL.revokeObjectURL(result.resultUrl);
  state.bytesHeld = Math.max(0, state.bytesHeld - result.size);

  const card = Array.from(elements.results.children).find(function(item) {
    return item.dataset.resultId === id;
  });
  if (card) card.remove();

  if (!state.results.length) {
    elements.batchToolbar.hidden = true;
    elements.progressWrap.hidden = true;
    state.selectedCount = 0;
    state.finishedCount = 0;
  }

  renderStatus();
}

function clearWorkspace(options = {}) {
  state.results.forEach(function(result) {
    URL.revokeObjectURL(result.originalUrl);
    URL.revokeObjectURL(result.resultUrl);
  });

  state.results = [];
  state.selectedCount = 0;
  state.finishedCount = 0;
  state.bytesHeld = 0;
  elements.results.replaceChildren();
  elements.batchToolbar.hidden = true;
  elements.progressWrap.hidden = true;
  elements.fileInput.value = '';
  renderStatus();

  if (!options.silent) {
    showToast('Workspace cleared.');
  }
}

async function clearWorkspaceCache() {
  clearWorkspace({ silent: true });
  await clearBrowserCacheStorage();
}

async function clearBrowserCacheStorage() {
  if (!('caches' in window)) return;

  try {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(function(cacheName) {
      if (cacheName.toLowerCase().includes('background') || cacheName.toLowerCase().includes('pixelcutpro')) {
        return caches.delete(cacheName);
      }
      return Promise.resolve(false);
    }));
  } catch (error) {
    console.warn('Could not clear Cache Storage:', error);
  }
}

function createOutputName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${base || 'image'}-transparent-bg.png`;
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function showToast(message, type = 'success') {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type}`;
  toastTimer = window.setTimeout(function() {
    elements.toast.className = 'toast';
  }, 3600);
}

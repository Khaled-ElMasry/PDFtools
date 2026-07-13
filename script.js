/* ================================================================
   PDF Tools — script.js   v1.0 (Sprint 1)
   Bugs fixed:
     B1  pt-file-row.is-drag-over now uses solid color, not var(--primary)
     B2  Double-escaped regex \\.[^/.]+$ → /\.[^/.]+$/ in download names
     B3  addImages() pushes all files first, then renders once
     B4  rangeBtn / resetBtn handlers attached once, not re-assigned per convert
     B5  JSZip removed entirely
     B6  MIME-type guard on image intake
     B7  PDF password errors caught → toast, not crash
     B8  All alert() calls replaced by showToast()
   ================================================================ */

'use strict';

/* ── PURE helpers (exposed for test harness) ──────────────────── */
const PURE = (() => {
    /**
     * Parse a page-range string like "1-5, 8, 11-13" into a Set of page numbers.
     * @param {string} rangeStr
     * @param {number} maxPages
     * @returns {Set<number>}
     */
    function parsePageRange(rangeStr, maxPages) {
        const pages = new Set();
        const parts = rangeStr.replace(/\s+/g, '').split(',');
        for (const part of parts) {
            if (!part) continue;
            if (part.includes('-')) {
                const [a, b] = part.split('-');
                const start = parseInt(a, 10);
                const end   = parseInt(b, 10);
                if (!isNaN(start) && !isNaN(end) && start <= end) {
                    for (let i = start; i <= end; i++) {
                        if (i >= 1 && i <= maxPages) pages.add(i);
                    }
                }
            } else {
                const num = parseInt(part, 10);
                if (!isNaN(num) && num >= 1 && num <= maxPages) pages.add(num);
            }
        }
        return pages;
    }

    /**
     * Format a MiB value into a human-readable string.
     * @param {number} mib
     * @returns {string}
     */
    function formatBytes(mib) {
        if (mib >= 1024)      return (mib / 1024).toFixed(2) + ' GiB';
        if (mib >= 1)         return mib.toFixed(2) + ' MiB';
        return (mib * 1024).toFixed(0) + ' KiB';
    }

    /**
     * Clamp a progress value to [0, 1].
     */
    function clampProgress(v) {
        if (typeof v !== 'number' || isNaN(v)) return 0;
        return Math.max(0, Math.min(1, v));
    }

    /**
     * Sanitize a proposed output filename (strips path separators,
     * control chars, reserved chars; deduplicates against a used-names set).
     * @param {string} raw         Original filename from user
     * @param {Set<string>} usedNames  Already-taken output names
     * @param {string} [ext='.png']    Target extension (with dot)
     */
    function sanitizeOutputName(raw, usedNames, ext = '.png') {
        // Duck-type the Set check so it works across jsdom realms too
        const used = usedNames && typeof usedNames.has === 'function' ? usedNames : new Set();

        // Strip existing extension
        let base = raw.replace(/\.[^/.]+$/, '');
        // Strip path separators
        base = base.replace(/[/\\]/g, '_');
        // Strip control characters and reserved chars: * < > | ? "
        base = base.replace(/[\x00-\x1f*<>|?"]/g, '_');
        // Collapse whitespace
        base = base.replace(/\s+/g, ' ').trim();
        // Fallback for empty
        if (!base) base = 'output';
        // Cap at 120 chars
        if (base.length > 120) base = base.slice(0, 120);

        // Deduplicate
        let candidate = base + ext;
        let n = 1;
        while (used.has(candidate)) {
            candidate = `${base} (${n})${ext}`;
            n++;
        }
        used.add(candidate);
        return candidate;
    }

    return { parsePageRange, formatBytes, clampProgress, sanitizeOutputName };
})();

/* Expose for test harness */
if (typeof window !== 'undefined' && window.__PDF_TEST_HOOK__) {
    window.__PDF_PURE__ = PURE;
}

/* ── SVG icon strings ─────────────────────────────────────────── */
const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  <line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
</svg>`;

const SVG_UNDO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
</svg>`;

/* ── Toast system (B8: replaces all alert() calls) ─────────────── */
function showToast(msg, type = 'info', durationMs = 4000) {
    const container = document.getElementById('pt-toasts');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'pt-toast' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.animation = 'pt-toastOut 0.3s ease forwards';
        el.addEventListener('animationend', () => el.remove());
    }, durationMs);
}

/* ── Tab switching ────────────────────────────────────────────── */
function initTabs() {
    const btns = document.querySelectorAll('.pt-tab-btn');
    const panels = document.querySelectorAll('.pt-tab-panel');

    btns.forEach((btn, i) => {
        btn.addEventListener('click', () => {
            btns.forEach((b, j) => {
                b.classList.toggle('is-active', j === i);
                b.setAttribute('aria-selected', j === i ? 'true' : 'false');
                b.setAttribute('tabindex', j === i ? '0' : '-1');
            });
            panels.forEach((p, j) => p.classList.toggle('is-active', j === i));
        });
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') {
                btns[(i + 1) % btns.length].focus();
                btns[(i + 1) % btns.length].click();
            } else if (e.key === 'ArrowLeft') {
                btns[(i - 1 + btns.length) % btns.length].focus();
                btns[(i - 1 + btns.length) % btns.length].click();
            }
        });
    });
}

/* ── Shared dropzone wiring ───────────────────────────────────── */
function wireDropzone(dzEl, inputEl, onFiles) {
    dzEl.addEventListener('click', () => inputEl.click());
    dzEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.click(); }
    });
    dzEl.addEventListener('dragover', (e) => { e.preventDefault(); dzEl.classList.add('is-dragover'); });
    dzEl.addEventListener('dragleave', () => dzEl.classList.remove('is-dragover'));
    dzEl.addEventListener('drop', (e) => {
        e.preventDefault();
        dzEl.classList.remove('is-dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) onFiles(Array.from(files));
    });
    inputEl.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) onFiles(Array.from(e.target.files));
    });
}

/* ── Set progress bar ─────────────────────────────────────────── */
function setProgress(fillId, textId, pct, msg, state = 'normal') {
    const fill = document.getElementById(fillId);
    const text = document.getElementById(textId);
    if (fill) {
        fill.style.width = pct + '%';
        fill.className = 'pt-progress-fill' +
            (state === 'error'   ? ' is-error'   :
             state === 'success' ? ' is-success' : '');
    }
    if (text && msg !== undefined) text.textContent = msg;
}

/* ═══════════════════════════════════════════════════════════════
   TAB 1 — PDF → Images
   ═══════════════════════════════════════════════════════════════ */
function initTab1() {
    let currentFile   = null;
    let selectedScale = 1.5;
    let renderedBlobs = [];   // indexed 0-based; matches page 1-based
    const usedNames   = new Set();

    const dz         = document.getElementById('pt-dz-1');
    const input      = document.getElementById('pt-input-1');
    const dzText     = document.getElementById('pt-dz-1-text');
    const dzSub      = document.getElementById('pt-dz-1-sub');
    const optPanel   = document.getElementById('pt-options-1');
    const convertBtn = document.getElementById('pt-convert-btn-1');
    const progressEl = document.getElementById('pt-progress-1');
    const gridWrap   = document.getElementById('pt-grid-wrapper-1');
    const grid       = document.getElementById('pt-grid-1');
    const zipBtn     = document.getElementById('pt-zip-btn-1');
    const resetBtn   = document.getElementById('pt-reset-btn-1');
    const rangeInput = document.getElementById('pt-range-input-1');
    const rangeBtn   = document.getElementById('pt-range-btn-1');
    const selectAll  = document.getElementById('pt-select-all-1');
    const deselectAll= document.getElementById('pt-deselect-all-1');

    // ── CRC32 table — hoisted out of ZIP handler (B5 / perf fix) ──
    const CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c;
    }
    function crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    wireDropzone(dz, input, (files) => {
        // B6: guard — only PDFs
        const pdf = files.find(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (!pdf) { showToast('Please select a valid PDF file.', 'error'); return; }
        handleFile(pdf);
    });

    function handleFile(file) {
        currentFile = file;
        dzText.textContent = file.name;
        dzSub.textContent  = 'File selected — choose quality and click Render.';
        optPanel.style.display = 'block';
        gridWrap.style.display = 'none';
        renderedBlobs = [];
        usedNames.clear();
    }

    // Quality chips
    document.querySelectorAll('#pt-quality-chips .pt-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#pt-quality-chips .pt-chip').forEach(c => {
                c.classList.remove('is-active');
                c.setAttribute('aria-checked', 'false');
            });
            chip.classList.add('is-active');
            chip.setAttribute('aria-checked', 'true');
            selectedScale = parseFloat(chip.dataset.scale);
        });
    });

    // ── B4: range/reset/zip handlers attached ONCE, not inside convertBtn ──

    rangeBtn.addEventListener('click', () => applyRange());

    function applyRange() {
        const rangeStr = rangeInput.value.trim();
        const cards = Array.from(grid.querySelectorAll('.pt-card'));
        if (!cards.length) return;
        if (!rangeStr) return;
        const active = PURE.parsePageRange(rangeStr, cards.length);
        cards.forEach(card => setCardExcluded(card, !active.has(parseInt(card.dataset.pageNum, 10))));
    }

    selectAll.addEventListener('click', () => {
        grid.querySelectorAll('.pt-card').forEach(card => setCardExcluded(card, false));
    });

    deselectAll.addEventListener('click', () => {
        grid.querySelectorAll('.pt-card').forEach(card => setCardExcluded(card, true));
    });

    // B4: resetBtn wired once
    resetBtn.addEventListener('click', resetTab1);

    function resetTab1() {
        grid.querySelectorAll('.pt-card-thumb img').forEach(img => URL.revokeObjectURL(img.src));
        grid.innerHTML = '';
        gridWrap.style.display = 'none';
        progressEl.style.display = 'none';
        zipBtn.style.display = 'none';
        resetBtn.style.display = 'none';
        optPanel.style.display = 'none';
        dzText.textContent = 'Drag & Drop PDF file here';
        dzSub.textContent  = 'Or press Enter / click to select a local PDF file';
        currentFile = null;
        input.value = '';
        rangeInput.value = '';
        dz.style.pointerEvents = 'auto';
        renderedBlobs = [];
        usedNames.clear();
    }

    // ── Helper: toggle a card's excluded state ─────────────────────
    function setCardExcluded(card, excluded) {
        const imgEl  = card.querySelector('.pt-card-thumb img');
        const rmBtn  = card.querySelector('.pt-card-rm');
        const lbl    = card.querySelector('.pt-card-label');
        const dlBtn  = card.querySelector('.pt-card-dl');

        card.dataset.removed = excluded ? 'true' : 'false';
        imgEl.style.opacity  = excluded ? '0.25' : '1';
        rmBtn.innerHTML      = excluded ? SVG_UNDO : SVG_TRASH;
        rmBtn.classList.toggle('is-undo', excluded);
        lbl.textContent      = excluded ? 'Excluded' : `Page ${card.dataset.pageNum}`;
        lbl.classList.toggle('is-excluded', excluded);
        if (dlBtn) dlBtn.style.display = excluded ? 'none' : 'inline-block';
    }

    // B4: ZIP wired once
    zipBtn.addEventListener('click', async () => {
        zipBtn.disabled = true;
        progressEl.style.display = 'block';
        setProgress('pt-progress-fill-1', 'pt-progress-text-1', 0, 'Preparing ZIP…');

        try {
            const cards = Array.from(grid.querySelectorAll('.pt-card'));
            const folderName = currentFile.name.replace(/\.[^/.]+$/, '');  // B2 fix
            const activeIndices = [];
            cards.forEach((c, i) => { if (c.dataset.removed !== 'true') activeIndices.push(i); });

            if (activeIndices.length === 0) {
                showToast('No pages selected — nothing to ZIP.', 'error');
                zipBtn.disabled = false;
                return;
            }

            const encoder = new TextEncoder();
            const now = new Date();
            const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
            const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

            const localParts = [];
            for (let idx = 0; idx < activeIndices.length; idx++) {
                const i = activeIndices[idx];
                const pct = Math.round(((idx + 1) / activeIndices.length) * 90);
                setProgress('pt-progress-fill-1', 'pt-progress-text-1', pct, `Packing file ${idx + 1}/${activeIndices.length}…`);

                const ab       = await renderedBlobs[i].arrayBuffer();
                const fileData = new Uint8Array(ab);
                const fileName = encoder.encode(`${folderName}/page_${i + 1}.png`);
                const crc      = crc32(fileData);
                const size     = fileData.length;

                const header = new Uint8Array(30);
                const hv = new DataView(header.buffer);
                hv.setUint32(0, 0x04034b50, true);
                hv.setUint16(4, 20, true);
                hv.setUint16(6, 0, true);
                hv.setUint16(8, 0, true);
                hv.setUint16(10, dosTime, true);
                hv.setUint16(12, dosDate, true);
                hv.setUint32(14, crc, true);
                hv.setUint32(18, size, true);
                hv.setUint32(22, size, true);
                hv.setUint16(26, fileName.length, true);
                hv.setUint16(28, 0, true);

                localParts.push({ header, blob: renderedBlobs[i], name: fileName, crc, size });
                await new Promise(r => setTimeout(r, 0));
            }

            setProgress('pt-progress-fill-1', 'pt-progress-text-1', 95, 'Finalizing ZIP…');

            let offset = 0;
            const centralEntries = [];
            const blobParts = [];

            for (const part of localParts) {
                blobParts.push(part.header, part.name, part.blob);
                const cd = new Uint8Array(46);
                const cv = new DataView(cd.buffer);
                cv.setUint32(0, 0x02014b50, true);
                cv.setUint16(4, 20, true);
                cv.setUint16(6, 20, true);
                cv.setUint16(8, 0, true);
                cv.setUint16(10, 0, true);
                cv.setUint16(12, dosTime, true);
                cv.setUint16(14, dosDate, true);
                cv.setUint32(16, part.crc, true);
                cv.setUint32(20, part.size, true);
                cv.setUint32(24, part.size, true);
                cv.setUint16(28, part.name.length, true);
                cv.setUint16(30, 0, true);
                cv.setUint16(32, 0, true);
                cv.setUint16(34, 0, true);
                cv.setUint16(36, 0, true);
                cv.setUint32(38, 0, true);
                cv.setUint32(42, offset, true);
                centralEntries.push(cd, part.name);
                offset += 30 + part.name.length + part.size;
            }

            let centralDirSize = 0;
            for (const ce of centralEntries) centralDirSize += ce.length;
            const eocd = new Uint8Array(22);
            const ev = new DataView(eocd.buffer);
            ev.setUint32(0, 0x06054b50, true);
            ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
            ev.setUint16(8, localParts.length, true);
            ev.setUint16(10, localParts.length, true);
            ev.setUint32(12, centralDirSize, true);
            ev.setUint32(16, offset, true);
            ev.setUint16(20, 0, true);

            const zipBlob = new Blob([...blobParts, ...centralEntries, eocd], { type: 'application/zip' });
            const zipUrl = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = zipUrl;
            a.download = folderName + '_pages.zip';
            a.click();
            setTimeout(() => URL.revokeObjectURL(zipUrl), 6000);

            setProgress('pt-progress-fill-1', 'pt-progress-text-1', 100, '✅ ZIP downloaded!', 'success');
        } catch (err) {
            setProgress('pt-progress-fill-1', 'pt-progress-text-1', 100, 'Error creating ZIP: ' + err.message, 'error');
        } finally {
            zipBtn.disabled = false;
        }
    });

    // ── Convert handler ──────────────────────────────────────────
    convertBtn.addEventListener('click', async () => {
        if (!currentFile) return;
        convertBtn.disabled = true;
        dz.style.pointerEvents = 'none';
        progressEl.style.display = 'block';
        setProgress('pt-progress-fill-1', 'pt-progress-text-1', 0, 'Reading document structure…');
        renderedBlobs = [];
        usedNames.clear();

        let pdf = null;
        try {
            const pdfjsLib = window.pdfjsLib;
            pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

            const ab = await currentFile.arrayBuffer();

            // B7: catch password-protected PDFs
            let loadTask;
            try {
                loadTask = pdfjsLib.getDocument({ data: ab });
                pdf = await loadTask.promise;
            } catch (loadErr) {
                if (loadErr && (loadErr.name === 'PasswordException' || String(loadErr).includes('password'))) {
                    showToast('⚠ This PDF is password-protected. Cannot render.', 'error', 6000);
                    setProgress('pt-progress-fill-1', 'pt-progress-text-1', 0, 'Cannot open password-protected PDF.', 'error');
                    return;
                }
                throw loadErr;
            }

            const pageCount = pdf.numPages;
            grid.innerHTML = '';
            gridWrap.style.display = 'block';
            zipBtn.style.display = 'none';

            const sharedCanvas = document.createElement('canvas');
            const sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });

            for (let i = 1; i <= pageCount; i++) {
                const pct = Math.round(((i - 1) / pageCount) * 100);
                setProgress('pt-progress-fill-1', 'pt-progress-text-1', pct, `Rendering page ${i}/${pageCount}…`);

                try {
                    const page     = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale: selectedScale });
                    sharedCanvas.width  = viewport.width;
                    sharedCanvas.height = viewport.height;
                    await page.render({ canvasContext: sharedCtx, viewport }).promise;

                    const blob   = await new Promise(res => sharedCanvas.toBlob(res, 'image/png'));
                    const imgUrl = URL.createObjectURL(blob);
                    renderedBlobs.push(blob);

                    await new Promise(r => setTimeout(r, 0)); // yield to UI

                    // Build card
                    const card = document.createElement('div');
                    card.className = 'pt-card';
                    card.dataset.pageNum = i;
                    card.dataset.removed = 'false';
                    card.setAttribute('role', 'listitem');

                    // B2 fix: /\.[^/.]+$/ not double-escaped
                    const dlName = currentFile.name.replace(/\.[^/.]+$/, '') + `_page_${i}.png`;

                    card.innerHTML = `
                        <button class="pt-card-rm" id="pt-rm-1-${i}" aria-label="Exclude page ${i}">${SVG_TRASH}</button>
                        <div class="pt-card-thumb" role="button" tabindex="0" aria-label="Open page ${i} in lightbox">
                            <img src="${imgUrl}" alt="Page ${i}" id="pt-img-1-${i}">
                        </div>
                        <div class="pt-card-footer">
                            <span class="pt-card-label" id="pt-lbl-1-${i}">Page ${i}</span>
                            <a href="${imgUrl}" download="${dlName}" class="pt-card-dl" id="pt-dl-1-${i}">↓ PNG</a>
                        </div>
                    `;

                    const rmBtn = card.querySelector('.pt-card-rm');
                    rmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const excluded = card.dataset.removed === 'true';
                        setCardExcluded(card, !excluded);
                    });

                    grid.appendChild(card);

                } catch (pageErr) {
                    console.error(`Skipping corrupted page ${i}`, pageErr);
                    renderedBlobs.push(new Blob()); // keep indices aligned
                }
            }

            setProgress('pt-progress-fill-1', 'pt-progress-text-1', 100, `✅ ${pageCount} pages rendered!`, 'success');
            zipBtn.style.display = 'block';
            resetBtn.style.display = 'block';

        } catch (err) {
            setProgress('pt-progress-fill-1', 'pt-progress-text-1', 100, 'Error: ' + err.message, 'error');
            showToast('Render failed: ' + err.message, 'error');
        } finally {
            if (pdf) { try { pdf.destroy(); } catch (_) {} }
            convertBtn.disabled = false;
            dz.style.pointerEvents = 'auto';
        }
    });
}

/* ═══════════════════════════════════════════════════════════════
   TAB 2 — Images → PDF
   ═══════════════════════════════════════════════════════════════ */
function initTab2() {
    let loadedImages = [];
    let selectedOrientation = 'p';
    let selectedMargin      = 'none';
    let currentPreviewIdx   = 0;

    const dz          = document.getElementById('pt-dz-2');
    const input       = document.getElementById('pt-input-2');
    const fileList    = document.getElementById('pt-file-list-2');
    const optPanel    = document.getElementById('pt-options-2');
    const compileBtn  = document.getElementById('pt-compile-btn');
    const resetBtn    = document.getElementById('pt-reset-btn-2');
    const progressEl  = document.getElementById('pt-progress-2');
    const previewBox  = document.getElementById('pt-preview-box');
    const previewImg  = document.getElementById('pt-preview-img');
    const previewCtr  = document.getElementById('pt-preview-counter');
    const previewCont = document.getElementById('pt-preview-container');
    const prevBtn     = document.getElementById('pt-preview-prev');
    const nextBtn     = document.getElementById('pt-preview-next');

    wireDropzone(dz, input, (files) => {
        // B6: MIME-type guard — only images
        const imgs = files.filter(f => f.type.startsWith('image/'));
        if (imgs.length === 0) {
            showToast('Please select PNG, JPEG or WebP image files.', 'error');  // B8
            return;
        }
        addImages(imgs);
    });

    // B3 fix: push ALL files first, then render once
    function addImages(files) {
        files.forEach(f => {
            loadedImages.push({ file: f, dataUrl: URL.createObjectURL(f) });
        });
        renderFileList();
    }

    function renderFileList() {
        if (loadedImages.length === 0) {
            fileList.style.display = 'none';
            optPanel.style.display = 'none';
            resetBtn.style.display = 'none';
            updatePreview();
            return;
        }
        fileList.style.display = 'block';
        optPanel.style.display = 'block';
        resetBtn.style.display = 'block';
        fileList.innerHTML = '';

        loadedImages.forEach((item, idx) => {
            const row = document.createElement('div');
            row.className = 'pt-file-row';
            row.draggable = true;

            row.innerHTML = `
                <img class="pt-file-thumb" src="${item.dataUrl}" alt="">
                <div class="pt-file-info">
                    <span class="pt-file-page-num">Page ${idx + 1}</span>
                    <span class="pt-file-name" title="${escHtml(item.file.name)}">${escHtml(item.file.name)}</span>
                </div>
                <div class="pt-file-btns">
                    <button class="pt-ctrl-btn" data-action="up"     data-idx="${idx}" aria-label="Move up">▲</button>
                    <button class="pt-ctrl-btn" data-action="down"   data-idx="${idx}" aria-label="Move down">▼</button>
                    <button class="pt-ctrl-btn is-delete" data-action="del" data-idx="${idx}" aria-label="Remove">✕</button>
                </div>
            `;

            // Drag-to-reorder
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', idx);
                setTimeout(() => row.style.opacity = '0.4', 0);
            });
            row.addEventListener('dragend', () => {
                row.style.opacity = '1';
                document.querySelectorAll('.pt-file-row').forEach(r => r.classList.remove('is-drag-over'));
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                row.classList.add('is-drag-over');  // B1 fix: CSS uses solid color now
            });
            row.addEventListener('dragleave', () => row.classList.remove('is-drag-over'));
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('is-drag-over');
                const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (from !== idx && !isNaN(from)) {
                    const item = loadedImages.splice(from, 1)[0];
                    let to = idx;
                    if (from < idx) to--;
                    loadedImages.splice(to, 0, item);
                    renderFileList();
                }
            });

            // Control buttons
            row.querySelector('[data-action="up"]').addEventListener('click', () => {
                if (idx > 0) {
                    [loadedImages[idx], loadedImages[idx - 1]] = [loadedImages[idx - 1], loadedImages[idx]];
                    renderFileList();
                }
            });
            row.querySelector('[data-action="down"]').addEventListener('click', () => {
                if (idx < loadedImages.length - 1) {
                    [loadedImages[idx], loadedImages[idx + 1]] = [loadedImages[idx + 1], loadedImages[idx]];
                    renderFileList();
                }
            });
            row.querySelector('[data-action="del"]').addEventListener('click', () => {
                URL.revokeObjectURL(loadedImages[idx].dataUrl);
                loadedImages.splice(idx, 1);
                renderFileList();
            });

            fileList.appendChild(row);
        });

        updatePreview();
    }

    // Orientation chips
    document.querySelectorAll('#pt-orient-chips .pt-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#pt-orient-chips .pt-chip').forEach(c => {
                c.classList.remove('is-active'); c.setAttribute('aria-checked', 'false');
            });
            chip.classList.add('is-active'); chip.setAttribute('aria-checked', 'true');
            selectedOrientation = chip.dataset.val;
            updatePreview();
        });
    });

    // Margin chips
    document.querySelectorAll('#pt-margin-chips .pt-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#pt-margin-chips .pt-chip').forEach(c => {
                c.classList.remove('is-active'); c.setAttribute('aria-checked', 'false');
            });
            chip.classList.add('is-active'); chip.setAttribute('aria-checked', 'true');
            selectedMargin = chip.dataset.val;
            updatePreview();
        });
    });

    // Preview navigation
    prevBtn.addEventListener('click', () => { if (currentPreviewIdx > 0) { currentPreviewIdx--; updatePreview(); } });
    nextBtn.addEventListener('click', () => { if (currentPreviewIdx < loadedImages.length - 1) { currentPreviewIdx++; updatePreview(); } });

    document.addEventListener('keydown', (e) => {
        const panel = document.getElementById('pt-panel-2');
        if (!panel || !panel.classList.contains('is-active')) return;
        if (e.target.tagName === 'INPUT') return;
        if (e.key === 'ArrowLeft' && currentPreviewIdx > 0) { currentPreviewIdx--; updatePreview(); }
        if (e.key === 'ArrowRight' && currentPreviewIdx < loadedImages.length - 1) { currentPreviewIdx++; updatePreview(); }
    });

    function updatePreview() {
        if (loadedImages.length === 0) {
            if (previewCont) previewCont.style.display = 'none';
            return;
        }
        currentPreviewIdx = Math.max(0, Math.min(currentPreviewIdx, loadedImages.length - 1));
        if (previewCont) previewCont.style.display = 'block';
        if (previewCtr)  previewCtr.textContent = `(Page ${currentPreviewIdx + 1} of ${loadedImages.length})`;
        if (prevBtn) prevBtn.style.opacity = currentPreviewIdx === 0 ? '0.3' : '1';
        if (nextBtn) nextBtn.style.opacity = currentPreviewIdx === loadedImages.length - 1 ? '0.3' : '1';

        const isPortrait = selectedOrientation === 'p';
        if (previewBox) {
            previewBox.style.width  = (isPortrait ? 220 : 311) + 'px';
            previewBox.style.height = (isPortrait ? 311 : 220) + 'px';
            let pad = selectedMargin === 'small' ? 12 : selectedMargin === 'medium' ? 24 : 0;
            previewBox.style.padding = pad + 'px';
        }
        if (previewImg && loadedImages[currentPreviewIdx]) {
            previewImg.src = loadedImages[currentPreviewIdx].dataUrl;
        }
    }

    // Reset
    resetBtn.addEventListener('click', () => {
        loadedImages.forEach(item => URL.revokeObjectURL(item.dataUrl));
        loadedImages = [];
        renderFileList();
        input.value = '';
        progressEl.style.display = 'none';
        setProgress('pt-progress-fill-2', 'pt-progress-text-2', 0, 'Generating PDF…');
    });

    // Compile
    compileBtn.addEventListener('click', async () => {
        if (loadedImages.length === 0) return;
        compileBtn.disabled = true;
        dz.style.pointerEvents = 'none';
        progressEl.style.display = 'block';
        setProgress('pt-progress-fill-2', 'pt-progress-text-2', 0, 'Formatting document…');

        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: selectedOrientation, unit: 'pt' });
            const margin = selectedMargin === 'none' ? 0 : selectedMargin === 'small' ? 20 : 40;

            for (let i = 0; i < loadedImages.length; i++) {
                const item = loadedImages[i];
                const pct = Math.round((i / loadedImages.length) * 100);
                setProgress('pt-progress-fill-2', 'pt-progress-text-2', pct, `Compiling page ${i + 1}/${loadedImages.length}…`);

                const compressed = await compressImage(item.dataUrl);

                if (i > 0) doc.addPage();

                const pw = doc.internal.pageSize.getWidth();
                const ph = doc.internal.pageSize.getHeight();
                const uw = pw - margin * 2;
                const uh = ph - margin * 2;
                const sc = Math.min(uw / compressed.w, uh / compressed.h);
                const dw = compressed.w * sc;
                const dh = compressed.h * sc;
                const x  = margin + (uw - dw) / 2;
                const y  = margin + (uh - dh) / 2;

                doc.addImage(compressed.dataUrl, 'JPEG', x, y, dw, dh);
                await new Promise(r => setTimeout(r, 0));
            }

            setProgress('pt-progress-fill-2', 'pt-progress-text-2', 100, 'Saving PDF…');
            const outNameEl = document.getElementById('pt-output-name');
            const outName = (outNameEl && outNameEl.value.trim()) ? outNameEl.value.trim() : 'compiled_document';
            doc.save(outName.replace(/\.pdf$/i, '') + '.pdf');

            setProgress('pt-progress-fill-2', 'pt-progress-text-2', 100, '✅ PDF generated!', 'success');
            showToast('PDF saved successfully!', 'success');
        } catch (err) {
            setProgress('pt-progress-fill-2', 'pt-progress-text-2', 100, 'Error: ' + err.message, 'error');
            showToast('Compile failed: ' + err.message, 'error');
        } finally {
            compileBtn.disabled = false;
            dz.style.pointerEvents = 'auto';
        }
    });

    function compressImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const maxD = 2400;
                const scale = (img.width > maxD || img.height > maxD)
                    ? Math.min(maxD / img.width, maxD / img.height) : 1;
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);
                resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.93), w, h });
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = url;
        });
    }
}

/* ═══════════════════════════════════════════════════════════════
   TAB 3 — Edit / Extract PDF
   ═══════════════════════════════════════════════════════════════ */
function initTab3() {
    let sourceFile     = null;
    let sourcePdfBytes = null;
    let replaceMap     = {};   // { pageNum: { url, file } }
    let removeSet      = new Set();
    let currentPdfDoc  = null;

    const dz          = document.getElementById('pt-dz-3');
    const input       = document.getElementById('pt-input-3');
    const dzText      = document.getElementById('pt-dz-3-text');
    const dzSub       = document.getElementById('pt-dz-3-sub');
    const progressEl  = document.getElementById('pt-progress-3');
    const gridWrap    = document.getElementById('pt-grid-wrapper-3');
    const grid        = document.getElementById('pt-grid-3');
    const saveBtn     = document.getElementById('pt-save-btn-3');
    const resetBtn    = document.getElementById('pt-reset-btn-3');
    const rangeInput  = document.getElementById('pt-range-input-3');
    const rangeBtn    = document.getElementById('pt-range-btn-3');
    const selectAll   = document.getElementById('pt-select-all-3');
    const deselectAll = document.getElementById('pt-deselect-all-3');

    wireDropzone(dz, input, (files) => {
        const pdf = files.find(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (!pdf) { showToast('Please select a valid PDF file.', 'error'); return; }
        handleFile(pdf);
    });

    // Grid drag-to-reorder
    grid.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const dragging = grid.querySelector('.is-dragging');
        if (!dragging) return;
        const target = e.target.closest('.pt-card');
        if (target && target !== dragging) {
            const box    = target.getBoundingClientRect();
            const offset = e.clientX - box.left - box.width / 2;
            grid.insertBefore(dragging, offset < 0 ? target : target.nextSibling);
        }
    });
    grid.addEventListener('drop', (e) => e.preventDefault());

    // B4: range/reset/save wired once
    rangeBtn.addEventListener('click', applyRange3);
    selectAll.addEventListener('click', () => {
        grid.querySelectorAll('.pt-card').forEach(c => setPageRemoved(c, false));
    });
    deselectAll.addEventListener('click', () => {
        grid.querySelectorAll('.pt-card').forEach(c => setPageRemoved(c, true));
    });
    resetBtn.addEventListener('click', resetTab3);

    function applyRange3() {
        const rangeStr = rangeInput.value.trim();
        const cards = Array.from(grid.querySelectorAll('.pt-card'));
        if (!cards.length || !rangeStr) return;
        const active = PURE.parsePageRange(rangeStr, cards.length);
        cards.forEach(card => setPageRemoved(card, !active.has(parseInt(card.dataset.pageNum, 10))));
    }

    function setPageRemoved(card, removed) {
        const pageNum = parseInt(card.dataset.pageNum, 10);
        const rmBtn   = document.getElementById(`pt-rm3-${pageNum}`);
        const imgEl   = document.getElementById(`pt-img3-${pageNum}`);
        const tagEl   = document.getElementById(`pt-tag3-${pageNum}`);

        if (removed) {
            removeSet.add(pageNum);
            if (rmBtn)  { rmBtn.innerHTML = SVG_UNDO; rmBtn.classList.add('is-undo'); }
            if (imgEl)  imgEl.style.opacity = '0.2';
            if (tagEl)  { tagEl.textContent = '(Removed)'; tagEl.className = 'pt-card-tag is-removed'; }
        } else {
            removeSet.delete(pageNum);
            if (rmBtn)  { rmBtn.innerHTML = SVG_TRASH; rmBtn.classList.remove('is-undo'); }
            if (imgEl)  imgEl.style.opacity = '1';
            if (tagEl) {
                if (replaceMap[pageNum]) {
                    tagEl.textContent = '(Replaced)'; tagEl.className = 'pt-card-tag is-replaced';
                } else {
                    tagEl.textContent = ''; tagEl.className = 'pt-card-tag';
                }
            }
        }
    }

    function resetTab3() {
        if (currentPdfDoc) { try { currentPdfDoc.destroy(); } catch (_) {} currentPdfDoc = null; }
        grid.querySelectorAll('img').forEach(img => URL.revokeObjectURL(img.src));
        Object.values(replaceMap).forEach(d => URL.revokeObjectURL(d.url));
        sourceFile = null; sourcePdfBytes = null;
        replaceMap = {}; removeSet = new Set();
        grid.innerHTML = '';
        gridWrap.style.display = 'none';
        progressEl.style.display = 'none';
        saveBtn.style.display = 'none';
        resetBtn.style.display = 'none';
        dzText.textContent = 'Drag & Drop original PDF here';
        dzSub.textContent  = 'Or press Enter / click to select a local PDF file';
        input.value = '';
        rangeInput.value = '';
    }

    async function handleFile(file) {
        if (currentPdfDoc) { try { currentPdfDoc.destroy(); } catch (_) {} currentPdfDoc = null; }
        sourceFile = file;
        replaceMap = {};
        removeSet  = new Set();
        dzText.textContent = file.name;
        dzSub.textContent  = 'Processing PDF…';

        progressEl.style.display = 'block';
        setProgress('pt-progress-fill-3', 'pt-progress-text-3', 0, 'Generating preview thumbnails…');
        gridWrap.style.display = 'none';
        grid.innerHTML = '';
        saveBtn.style.display = 'none';

        let pdf = null;
        try {
            sourcePdfBytes = await file.arrayBuffer();
            const pdfjsLib = window.pdfjsLib;
            pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

            // B7: password check
            try {
                const task = pdfjsLib.getDocument({ data: sourcePdfBytes });
                pdf = await task.promise;
                currentPdfDoc = pdf;
            } catch (loadErr) {
                if (loadErr && (loadErr.name === 'PasswordException' || String(loadErr).includes('password'))) {
                    showToast('⚠ This PDF is password-protected.', 'error', 6000);
                    setProgress('pt-progress-fill-3', 'pt-progress-text-3', 0, 'Cannot open password-protected PDF.', 'error');
                    return;
                }
                throw loadErr;
            }

            const pageCount = pdf.numPages;
            gridWrap.style.display = 'block';

            const sharedCanvas = document.createElement('canvas');
            const sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });

            for (let i = 1; i <= pageCount; i++) {
                const pct = Math.round((i / pageCount) * 100);
                setProgress('pt-progress-fill-3', 'pt-progress-text-3', pct, `Thumbnailing page ${i}/${pageCount}…`);

                try {
                    const page     = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale: 0.5 });
                    sharedCanvas.width  = viewport.width;
                    sharedCanvas.height = viewport.height;
                    await page.render({ canvasContext: sharedCtx, viewport }).promise;
                    const blob   = await new Promise(res => sharedCanvas.toBlob(res, 'image/jpeg', 0.75));
                    const imgUrl = URL.createObjectURL(blob);
                    await new Promise(r => setTimeout(r, 0));

                    const card = document.createElement('div');
                    card.className  = 'pt-card';
                    card.draggable  = true;
                    card.dataset.pageNum = i;
                    card.style.position  = 'relative';
                    card.style.cursor    = 'grab';
                    card.setAttribute('role', 'listitem');

                    card.innerHTML = `
                        <button class="pt-card-rm" id="pt-rm3-${i}" aria-label="Remove page ${i}">${SVG_TRASH}</button>
                        <div class="pt-card-thumb" role="button" tabindex="0" aria-label="Open page ${i} in lightbox">
                            <img src="${imgUrl}" alt="Page ${i}" id="pt-img3-${i}" style="pointer-events:none">
                        </div>
                        <div class="pt-card-footer">
                            <span class="pt-card-label">Page ${i}</span>
                            <span class="pt-card-tag" id="pt-tag3-${i}"></span>
                        </div>
                        <div class="pt-card-action-col">
                            <button class="pt-card-btn" id="pt-rep3-${i}">Replace</button>
                            <button class="pt-card-btn" id="pt-dl3-${i}">Download</button>
                        </div>
                    `;

                    // Drag-reorder
                    card.addEventListener('dragstart', function (e) {
                        e.dataTransfer.effectAllowed = 'move';
                        this.classList.add('is-dragging');
                        this.style.opacity = '0.4';
                    });
                    card.addEventListener('dragend', function () {
                        this.classList.remove('is-dragging');
                        this.style.opacity = removeSet.has(parseInt(this.dataset.pageNum, 10)) ? '0.2' : '1';
                    });

                    // Remove / undo toggle
                    const rmBtn = card.querySelector('.pt-card-rm');
                    rmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        setPageRemoved(card, !removeSet.has(i));
                    });

                    // Replace page
                    document.getElementById(`pt-rep3-${i}`).addEventListener('click', () => {
                        const fi = document.createElement('input');
                        fi.type = 'file';
                        fi.accept = 'image/png,image/jpeg,image/jpg,image/webp';
                        fi.onchange = (e) => {
                            const f = e.target.files[0];
                            if (!f) return;
                            if (replaceMap[i]) URL.revokeObjectURL(replaceMap[i].url);
                            const newUrl = URL.createObjectURL(f);
                            document.getElementById(`pt-img3-${i}`).src = newUrl;
                            const tagEl = document.getElementById(`pt-tag3-${i}`);
                            tagEl.textContent = '(Replaced)'; tagEl.className = 'pt-card-tag is-replaced';
                            replaceMap[i] = { url: newUrl, file: f };
                        };
                        fi.click();
                    });

                    // Download page (HD render)
                    document.getElementById(`pt-dl3-${i}`).addEventListener('click', async () => {
                        // If replaced, download the replacement image
                        if (replaceMap[i]) {
                            const a = document.createElement('a');
                            a.href = replaceMap[i].url;
                            // B2 fix: proper regex
                            a.download = `${file.name.replace(/\.[^/.]+$/, '')}_page_${i}_replaced.png`;
                            a.click();
                            return;
                        }
                        // Otherwise render at 3× and download
                        const dlBtn = document.getElementById(`pt-dl3-${i}`);
                        dlBtn.textContent = '…';
                        dlBtn.style.pointerEvents = 'none';
                        try {
                            const dlPage     = await pdf.getPage(i);
                            const dlViewport = dlPage.getViewport({ scale: 3.0 });
                            const dlCanvas   = document.createElement('canvas');
                            dlCanvas.width   = dlViewport.width;
                            dlCanvas.height  = dlViewport.height;
                            await dlPage.render({ canvasContext: dlCanvas.getContext('2d'), viewport: dlViewport }).promise;
                            const dlBlob = await new Promise(res => dlCanvas.toBlob(res, 'image/png'));
                            const dlUrl  = URL.createObjectURL(dlBlob);
                            const a = document.createElement('a');
                            a.href = dlUrl;
                            // B2 fix: proper regex
                            a.download = `${file.name.replace(/\.[^/.]+$/, '')}_page_${i}_HD.png`;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(dlUrl), 4000);
                        } catch (err) {
                            showToast('Download error: ' + err.message, 'error');
                        } finally {
                            dlBtn.textContent = 'Download';
                            dlBtn.style.pointerEvents = 'auto';
                        }
                    });

                    grid.appendChild(card);

                } catch (pageErr) {
                    console.error(`Skipping corrupted page ${i}`, pageErr);
                }
            }

            setProgress('pt-progress-fill-3', 'pt-progress-text-3', 100, '✅ Ready — replace or remove pages, then save.', 'success');
            saveBtn.style.display = 'block';
            resetBtn.style.display = 'block';
            dzSub.textContent = 'Click a page\'s Replace button to swap it.';

        } catch (err) {
            setProgress('pt-progress-fill-3', 'pt-progress-text-3', 100, 'Error loading PDF: ' + err.message, 'error');
            showToast('Failed to load PDF: ' + err.message, 'error');
        }
    }

    // Save
    saveBtn.addEventListener('click', async () => {
        if (!sourceFile) return;
        saveBtn.disabled = true;
        setProgress('pt-progress-fill-3', 'pt-progress-text-3', 0, 'Injecting replacements…');
        progressEl.style.display = 'block';

        try {
            const { PDFDocument } = window.PDFLib;
            const buf = await sourceFile.arrayBuffer();
            const srcDoc = await PDFDocument.load(buf);
            const newDoc = await PDFDocument.create();

            const cards = Array.from(grid.querySelectorAll('.pt-card'));

            // Batch copy unmodified pages at once
            const unmodifiedIndices = [];
            for (const card of cards) {
                const n = parseInt(card.dataset.pageNum, 10);
                if (!removeSet.has(n) && !replaceMap[n]) unmodifiedIndices.push(n - 1);
            }
            let copiedPages = [];
            if (unmodifiedIndices.length > 0) {
                copiedPages = await newDoc.copyPages(srcDoc, unmodifiedIndices);
            }
            let copyCounter = 0;

            for (let i = 0; i < cards.length; i++) {
                const n = parseInt(cards[i].dataset.pageNum, 10);
                const pct = Math.round(((i + 1) / cards.length) * 100);
                setProgress('pt-progress-fill-3', 'pt-progress-text-3', pct, `Processing page ${i + 1}/${cards.length}…`);

                if (removeSet.has(n)) continue;

                if (replaceMap[n]) {
                    const rep  = replaceMap[n];
                    const old  = srcDoc.getPage(n - 1);
                    const { width, height } = old.getSize();
                    const newPage = newDoc.addPage([width, height]);

                    const imgBuf = await rep.file.arrayBuffer();
                    let embedded;
                    if (rep.file.type === 'image/png') {
                        embedded = await newDoc.embedPng(imgBuf);
                    } else if (rep.file.type === 'image/jpeg' || rep.file.type === 'image/jpg') {
                        embedded = await newDoc.embedJpg(imgBuf);
                    } else {
                        // webp fallback — draw to canvas, export as JPEG
                        const tmpCanvas = document.createElement('canvas');
                        const tmpCtx    = tmpCanvas.getContext('2d');
                        const tmpImg    = new Image();
                        tmpImg.src = rep.url;
                        await new Promise((res, rej) => { tmpImg.onload = res; tmpImg.onerror = rej; });
                        tmpCanvas.width = tmpImg.width; tmpCanvas.height = tmpImg.height;
                        tmpCtx.drawImage(tmpImg, 0, 0);
                        const fb = await new Promise(res => tmpCanvas.toBlob(res, 'image/jpeg', 0.94));
                        embedded = await newDoc.embedJpg(new Uint8Array(await fb.arrayBuffer()));
                    }

                    const iw    = embedded.width;
                    const ih    = embedded.height;
                    const sc    = Math.min(width / iw, height / ih);
                    const dw    = iw * sc;
                    const dh    = ih * sc;
                    newPage.drawImage(embedded, {
                        x: (width - dw) / 2, y: (height - dh) / 2, width: dw, height: dh
                    });
                } else {
                    newDoc.addPage(copiedPages[copyCounter++]);
                }

                await new Promise(r => setTimeout(r, 0));
            }

            const bytes = await newDoc.save();
            const blob  = new Blob([bytes], { type: 'application/pdf' });
            const url   = URL.createObjectURL(blob);
            const a     = document.createElement('a');
            a.href = url;
            // B2 fix: proper regex
            a.download = sourceFile.name.replace(/\.[^/.]+$/, '') + '_edited.pdf';
            a.click();
            URL.revokeObjectURL(url);

            setProgress('pt-progress-fill-3', 'pt-progress-text-3', 100, '✅ Lossless PDF saved!', 'success');
            showToast('PDF saved successfully!', 'success');
        } catch (err) {
            setProgress('pt-progress-fill-3', 'pt-progress-text-3', 100, 'Error: ' + err.message, 'error');
            showToast('Save failed: ' + err.message, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });
}

/* ═══════════════════════════════════════════════════════════════
   LIGHTBOX — shared across Tab 1 and Tab 3
   ═══════════════════════════════════════════════════════════════ */
function initLightbox() {
    const lb      = document.getElementById('pt-lightbox');
    const lbImg   = document.getElementById('pt-lb-img');
    const lbCtr   = document.getElementById('pt-lb-counter');
    const lbClose = document.getElementById('pt-lb-close');
    const lbPrev  = document.getElementById('pt-lb-prev');
    const lbNext  = document.getElementById('pt-lb-next');

    let imgs = [];
    let idx  = 0;

    function open(images, startIdx) {
        imgs = images; idx = startIdx;
        lb.style.display = 'flex';
        render();
        lbImg.focus();
    }

    function close() {
        lb.style.display = 'none'; imgs = []; idx = 0;
    }

    function render() {
        if (!imgs.length) return;
        lbImg.style.opacity = '0';
        setTimeout(() => {
            lbImg.src = imgs[idx].src;
            lbImg.style.opacity = '1';
        }, 100);
        lbCtr.textContent = `Page ${idx + 1} of ${imgs.length}`;
        lbPrev.style.opacity = idx === 0 ? '0.3' : '1';
        lbNext.style.opacity = idx === imgs.length - 1 ? '0.3' : '1';
    }

    lbClose.addEventListener('click', close);
    lbPrev.addEventListener('click', () => { if (idx > 0) { idx--; render(); } });
    lbNext.addEventListener('click', () => { if (idx < imgs.length - 1) { idx++; render(); } });

    lb.addEventListener('click', (e) => { if (e.target === lb) close(); });

    document.addEventListener('keydown', (e) => {
        if (lb.style.display !== 'flex') return;
        if (e.key === 'ArrowLeft'  && idx > 0)             { idx--; render(); }
        if (e.key === 'ArrowRight' && idx < imgs.length - 1) { idx++; render(); }
        if (e.key === 'Escape') close();
    });

    // Delegate clicks on .pt-card-thumb inside any grid
    document.body.addEventListener('click', (e) => {
        const thumb = e.target.closest('.pt-card-thumb');
        if (!thumb) return;
        const grid = thumb.closest('.pt-grid');
        if (!grid) return;
        const allImgs = Array.from(grid.querySelectorAll('.pt-card-thumb img'));
        const clicked = thumb.querySelector('img');
        const startIdx = allImgs.indexOf(clicked);
        if (startIdx !== -1) open(allImgs, startIdx);
    });
}

/* ── Utility ──────────────────────────────────────────────────── */
function escHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ── Bootstrap ────────────────────────────────────────────────── */
function boot() {
    initTabs();
    initTab1();
    initTab2();
    initTab3();
    initLightbox();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}

/**
 * LexisLocal OCR Engine
 * Zpracovává naskenované dokumenty (PNG, JPG, TIFF) a skeny v PDF
 * pomocí Tesseract.js (pure JS, žádné systémové závislosti).
 * 
 * Podporované formáty:
 *   - Obrázky: PNG, JPG, JPEG, TIFF, BMP, WEBP
 *   - Skenované PDF: pokud pdf-parse vrátí méně než MIN_PDF_TEXT_LENGTH znaků
 *     (heuristika pro detekci naskenovaného PDF bez digitálního textu)
 */

const fs = require('fs');
const path = require('path');

// Minimum characters expected from a digital PDF before we consider it scanned
const MIN_PDF_TEXT_LENGTH = 80;

// Supported image extensions
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp'];

/**
 * Extract clean plaintext from a Word .docx document using native Mac unzip and XML matching.
 * Requires no external NPM zip libraries, works out of the box and is extremely fast!
 */
async function extractTextFromDocx(filePath) {
    const { execFile } = require('child_process');
    const util = require('util');
    const execFileAsync = util.promisify(execFile);

    try {
        // Run native unzip -p to print word/document.xml directly to stdout
        // Passed carefully as an array to prevent command injection
        const { stdout: documentXml } = await execFileAsync('unzip', ['-p', filePath, 'word/document.xml'], {
            encoding: 'utf-8', 
            maxBuffer: 50 * 1024 * 1024 // 50MB buffer safety
        });
        
        // Find all paragraph blocks
        const paragraphMatches = documentXml.match(/<w:p[^>]*>([\s\S]*?)<\/w:p>/g) || [];
        
        const paragraphs = paragraphMatches.map(p => {
            // For each paragraph, find all text runs
            const textMatches = p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
            // Merge text runs and strip XML tags (un-escape XML entities if any)
            return textMatches
                .map(m => m.replace(/<[^>]+>/g, ''))
                .join('')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'");
        });
        
        return paragraphs.join('\n\n').trim();
    } catch (err) {
        throw new Error(`Chyba při parsování Word XML: ${err.message}`);
    }
}

/**
 * Check if a file extension is an image we can OCR directly
 */
function isImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Run Tesseract OCR on an image file path or buffer.
 * Uses tesseract.js which is pure JS and requires no system installation.
 * Language: Czech + English ('ces+eng') for best results with legal documents.
 */
async function runTesseractOCR(imagePathOrBuffer) {
    try {
        const { createWorker } = require('tesseract.js');
        
        // errorHandler je NUTNÝ: bez něj tesseract.js chybu workeru (např. nedostupná
        // jazyková data na CDN v offline kanceláři) vyhodí mimo Promise a SHODÍ celý
        // server (zjištěno 2. 10. 2026). Jazyková data lze dodat offline přes
        // LEXIS_TESSDATA_DIR (složka s ces.traineddata(.gz) a eng.traineddata(.gz)).
        let workerError = null, failWorker = null;
        const failed = new Promise((_, reject) => { failWorker = reject; });
        const opts = {
            errorHandler: (e) => { workerError = e; console.error('❌ OCR worker:', e && e.message ? e.message : e); failWorker(e instanceof Error ? e : new Error(String(e))); },
            logger: m => {
                if (m.status === 'recognizing text') {
                    process.stdout.write(`\r🔍 OCR: ${Math.round(m.progress * 100)}%`);
                }
            }
        };
        if (process.env.LEXIS_TESSDATA_DIR) { opts.langPath = process.env.LEXIS_TESSDATA_DIR; opts.cachePath = process.env.LEXIS_TESSDATA_DIR; }
        const timeoutMs = parseInt(process.env.LEXIS_OCR_TIMEOUT_MS, 10) || 120000;
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`OCR nedoběhlo do ${timeoutMs / 1000} s`)), timeoutMs); });
        failed.catch(() => {}); timeout.catch(() => {});
        const pending = createWorker('ces+eng', 1, opts);
        let worker;
        try {
            worker = await Promise.race([pending, failed, timeout]);
        } catch (e) {
            clearTimeout(timer);
            pending.then(w => w.terminate()).catch(() => {});
            throw e;
        }
        if (workerError) { clearTimeout(timer); try { await worker.terminate(); } catch (e) { /* ignore */ } throw workerError; }

        let text;
        try {
            ({ data: { text } } = await Promise.race([worker.recognize(imagePathOrBuffer), failed, timeout]));
        } finally {
            clearTimeout(timer);
        }
        await worker.terminate();
        
        process.stdout.write('\n');
        return text.trim();
    } catch (err) {
        console.error('❌ OCR: Tesseract.js selhal:', err.message);
        return '';
    }
}

/**
 * Convert a single PDF page to a PNG buffer using pdfjs-dist.
 * Returns an array of image buffers (one per page), up to maxPages.
 */
async function pdfToImageBuffers(pdfBuffer, maxPages = 10) {
    try {
        // pdfjs-dist v6+ je ESM (pdf.mjs) → dynamic import; v5 fallback na CJS (pdf.js).
        let pdfjs;
        try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
        catch (e) { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
        
        // Worker: v6 vyžaduje cestu k worker souboru (.mjs); v5 fallback (.js).
        // (Prázdný workerSrc už v6 fake-worker nespustí — proto resolvujeme soubor.)
        try {
            pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        } catch (e) {
            try { pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js'); }
            catch (e2) { pdfjs.GlobalWorkerOptions.workerSrc = ''; }
        }
        
        // isEvalSupported:false — obrana proti spouštění kódu ze škodlivého PDF (CVE pdf.js).
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), isEvalSupported: false });
        const pdfDoc = await loadingTask.promise;
        
        const numPages = Math.min(pdfDoc.numPages, maxPages);
        const { createCanvas } = require('canvas');
        
        const pageBuffers = [];
        
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            console.log(`📄 OCR: Renderuji stránku ${pageNum}/${numPages}...`);
            
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 }); // 2x scale = better OCR accuracy
            
            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext('2d');
            
            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;
            
            const buffer = canvas.toBuffer('image/png');
            pageBuffers.push(buffer);
        }
        
        return pageBuffers;
    } catch (err) {
        console.error('❌ OCR: PDF-to-image konverze selhala:', err.message);
        return [];
    }
}

/**
 * PRIMARY API: Extract text from a scanned/image PDF using OCR pipeline.
 * Steps: PDF buffer → page images (pdfjs-dist + canvas) → Tesseract OCR
 */
async function ocrScannedPdf(pdfBuffer) {
    console.log('🔬 OCR: Zahajuji OCR pipeline pro naskenované PDF...');
    
    const pageImages = await pdfToImageBuffers(pdfBuffer, 15); // Max 15 pages
    
    if (pageImages.length === 0) {
        console.warn('⚠️ OCR: Nepodařilo se vyrenderovat žádnou stránku PDF.');
        return '';
    }
    
    let fullText = '';
    
    for (let i = 0; i < pageImages.length; i++) {
        console.log(`🔍 OCR: Rozpoznávám text na stránce ${i + 1}/${pageImages.length}...`);
        const pageText = await runTesseractOCR(pageImages[i]);
        if (pageText) {
            fullText += `\n\n--- Strana ${i + 1} ---\n${pageText}`;
        }
    }
    
    return fullText.trim();
}

/**
 * PRIMARY API: Extract text from an image file using Tesseract OCR.
 */
async function ocrImageFile(filePath) {
    console.log(`🔬 OCR: Zahajuji OCR pro obrázek: ${path.basename(filePath)}`);
    return await runTesseractOCR(filePath);
}

/**
 * DETECTOR: Returns true if the extracted PDF text is too short to be a digital PDF
 * (i.e., it's likely a scanned document with no embedded text layer).
 */
function isScannedPdf(extractedText) {
    const cleanText = (extractedText || '').replace(/\s+/g, '').trim();
    return cleanText.length < MIN_PDF_TEXT_LENGTH;
}

/**
 * MAIN ENTRY: Intelligently extract text from any file:
 *   - TXT/HTML: reads directly
 *   - Digital PDF: uses pdf-parse
 *   - Scanned PDF: falls back to OCR pipeline
 *   - Image (PNG/JPG/etc.): runs Tesseract OCR directly
 *
 * Returns: { text: string, ocr: boolean, pages?: number }
 */
async function extractTextFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    // === Plain text files ===
    if (ext === '.txt' || ext === '.html') {
        const text = fs.readFileSync(filePath, 'utf-8');
        return { text, ocr: false };
    }
    
    // === Word .docx files (using native unzip + XML parsing) ===
    if (ext === '.docx') {
        try {
            const text = await extractTextFromDocx(filePath);
            return { text, ocr: false };
        } catch (err) {
            console.error(`❌ Word: Selhala extrakce z .docx souboru ${path.basename(filePath)}:`, err.message);
            return { text: '', ocr: false };
        }
    }

    // === Image files: direct OCR ===
    if (isImageFile(filePath)) {
        const text = await ocrImageFile(filePath);
        return { text, ocr: true };
    }
    
    // === PDF: try digital first, fall back to OCR ===
    if (ext === '.pdf') {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(filePath);
        
        try {
            const parsedPdf = await pdfParse(dataBuffer);
            const digitalText = parsedPdf.text || '';
            
            if (!isScannedPdf(digitalText)) {
                // ✅ Digital PDF – text extracted normally
                console.log(`✅ PDF: Digitální text úspěšně přečten (${digitalText.length} znaků).`);
                return { text: digitalText, ocr: false };
            }
            
            // 🔬 Scanned PDF detected – run OCR
            console.log(`🔬 OCR: Detekováno naskenované PDF (pouze ${digitalText.length} znaků), spouštím OCR pipeline...`);
            const ocrText = await ocrScannedPdf(dataBuffer);
            
            if (ocrText) {
                console.log(`✅ OCR: Úspěšně extrahováno ${ocrText.length} znaků z naskenovaného PDF.`);
                return { text: ocrText, ocr: true };
            }
            
            // OCR also failed - return whatever we have
            console.warn('⚠️ OCR: Ani OCR neposkytl text. Vracím prázdný řetězec.');
            return { text: '', ocr: true };
            
        } catch (pdfErr) {
            console.warn(`⚠️ PDF-parse selhal: ${pdfErr.message}. Zkouším OCR pipeline...`);
            const ocrText = await ocrScannedPdf(fs.readFileSync(filePath));
            return { text: ocrText, ocr: true };
        }
    }
    
    return { text: '', ocr: false };
}

module.exports = {
    extractTextFromFile,
    ocrImageFile,
    ocrScannedPdf,
    isScannedPdf,
    isImageFile,
    IMAGE_EXTENSIONS
};

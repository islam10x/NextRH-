import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

export type EmployeeStorageCategory = 'CV' | 'Certifications' | 'Trainings';
const execFileAsync = promisify(execFile);

interface CertificationMetadata {
    name: string;
    status: 'active' | 'expired' | 'unknown';
    expiration: string | null;
}

export interface EmployeeMetadata {
    name: string;
    skills: string[];
    certifications: CertificationMetadata[];
    experience_years: number;
    last_update: string;
}

interface EmployeeStorageOwner {
    userId: string;
    email: string;
}

interface LlmExtraction {
    name?: string;
    skills?: string[];
    certifications?: CertificationMetadata[];
    experience_years?: number;
}

@Injectable()
export class FileStorageService {
    constructor(private readonly usersService: UsersService) { }

    async saveEmployeeFile(userId: string, file: Express.Multer.File, category: EmployeeStorageCategory) {
        const user = await this.usersService.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const existingBaseDir = await this.findBaseDirByOwner(user.user_id);
        const extracted = await this.extractDocumentInsights(file, category);
        const llm = await this.extractStructuredWithOllama(extracted.text, category);
        const preferredName =
            category === 'CV'
                ? (extracted.name || llm?.name || '')
                : (llm?.name || extracted.name || '');
        const fallbackName =
            [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
            || user.email?.split('@')[0]
            || 'employee';
        const employeeName = await this.resolveEmployeeNameForUpload(
            category,
            preferredName,
            existingBaseDir,
            fallbackName
        );
        const alignedBaseDir = await this.alignEmployeeFolderName(
            category,
            existingBaseDir,
            employeeName,
            user.user_id,
            user.email
        );

        const { baseDir, metadataPath, targetDir } = await this.ensureEmployeeDirs(
            employeeName,
            user.user_id,
            user.email,
            category,
            alignedBaseDir
        );
        const safeOriginalName = this.sanitizeFileName(file.originalname || 'file');
        const storedName =
            category === 'CV'
                ? `CV${this.resolveExtension(file, safeOriginalName)}`
                : await this.resolveStoredName(targetDir, safeOriginalName);

        const fullPath = path.join(targetDir, storedName);
        await fs.writeFile(fullPath, file.buffer);

        await this.upsertMetadata(metadataPath, {
            category,
            employeeName,
            extractedText: extracted.text,
            originalName: file.originalname || safeOriginalName,
            llm,
        });

        return {
            message: 'File uploaded successfully',
            path: path.relative(process.cwd(), fullPath),
            filename: storedName,
            baseDir: path.relative(process.cwd(), baseDir),
        };
    }

    async getEmployeeMetadata(userId: string): Promise<EmployeeMetadata> {
        const user = await this.usersService.findById(userId);
        const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email.split('@')[0];

        const baseDir = await this.findBaseDirByOwner(user.user_id);
        if (!baseDir) {
            return {
                name: fallbackName,
                skills: [],
                certifications: [],
                experience_years: 0,
                last_update: this.currentDate(),
            };
        }

        const metadataPath = path.join(baseDir, 'metadata.json');
        try {
            const parsed = await this.readMetadataFile(metadataPath);
            if (!parsed) {
                throw new Error('Metadata not found');
            }
            return {
                name: parsed.name || fallbackName,
                skills: Array.isArray(parsed.skills) ? parsed.skills : [],
                certifications: Array.isArray(parsed.certifications) ? parsed.certifications : [],
                experience_years: typeof parsed.experience_years === 'number' ? parsed.experience_years : 0,
                last_update: typeof parsed.last_update === 'string' ? parsed.last_update : this.currentDate(),
            };
        } catch {
            return {
                name: fallbackName,
                skills: [],
                certifications: [],
                experience_years: 0,
                last_update: this.currentDate(),
            };
        }
    }

    private async ensureEmployeeDirs(
        employeeName: string,
        userId: string,
        email: string,
        category: EmployeeStorageCategory,
        existingBaseDir?: string | null
    ) {
        const baseDir = existingBaseDir || await this.resolveEmployeeBaseDir(employeeName, userId, email);
        const targetDir =
            category === 'Certifications'
                ? path.join(baseDir, 'Certificates')
                : baseDir;
        const certificatesDir = path.join(baseDir, 'Certificates');
        const metadataPath = path.join(baseDir, 'metadata.json');

        await fs.mkdir(targetDir, { recursive: true });
        await fs.mkdir(certificatesDir, { recursive: true });
        return { baseDir, metadataPath, targetDir };
    }

    private async resolveEmployeeNameForUpload(
        category: EmployeeStorageCategory,
        extractedName: string,
        existingBaseDir: string | null,
        fallbackName: string
    ) {
        if (category === 'CV') {
            const name = (extractedName || '').trim();
            return name || fallbackName;
        }

        if (!existingBaseDir) {
            throw new BadRequestException(
                'Upload CV first. The employee folder name must be extracted from CV content.'
            );
        }

        const existingMetadata = await this.readMetadataFile(path.join(existingBaseDir, 'metadata.json'));
        if (existingMetadata?.name) {
            return existingMetadata.name.trim();
        }

        return path.basename(existingBaseDir).replace(/_/g, ' ').trim();
    }

    private async resolveEmployeeBaseDir(employeeName: string, userId: string, email: string) {
        const existingBaseDir = await this.findBaseDirByOwner(userId);
        if (existingBaseDir) {
            await this.writeOwnerMarker(existingBaseDir, { userId, email });
            return existingBaseDir;
        }

        const rootDir = this.getStorageRoot();
        await fs.mkdir(rootDir, { recursive: true });
        const folderName = this.buildSafeFolderName(employeeName, userId);
        const baseDir = path.join(rootDir, folderName);
        await fs.mkdir(baseDir, { recursive: true });
        await this.writeOwnerMarker(baseDir, { userId, email });
        return baseDir;
    }

    private async alignEmployeeFolderName(
        category: EmployeeStorageCategory,
        existingBaseDir: string | null,
        employeeName: string,
        userId: string,
        email: string
    ) {
        if (category !== 'CV' || !existingBaseDir) {
            return existingBaseDir;
        }

        const desiredFolderName = this.buildSafeFolderName(employeeName, userId);
        const currentFolderName = path.basename(existingBaseDir);
        if (currentFolderName === desiredFolderName) {
            return existingBaseDir;
        }

        const desiredBaseDir = path.join(this.getStorageRoot(), desiredFolderName);
        try {
            await fs.access(desiredBaseDir);
            // If destination already exists, keep current to avoid destructive merge.
            await this.writeOwnerMarker(existingBaseDir, { userId, email });
            return existingBaseDir;
        } catch {
            // Destination does not exist, rename is safe.
        }

        try {
            await fs.rename(existingBaseDir, desiredBaseDir);
            await this.writeOwnerMarker(desiredBaseDir, { userId, email });
            return desiredBaseDir;
        } catch {
            await this.writeOwnerMarker(existingBaseDir, { userId, email });
            return existingBaseDir;
        }
    }

    private async findBaseDirByOwner(userId: string) {
        const rootDir = this.getStorageRoot();
        try {
            const entries = await fs.readdir(rootDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const baseDir = path.join(rootDir, entry.name);
                const owner = await this.readOwnerMarker(baseDir);
                if (owner?.userId === userId) return baseDir;
            }
        } catch {
            return null;
        }
        return null;
    }

    private async readOwnerMarker(baseDir: string) {
        const ownerPath = path.join(baseDir, '.owner.json');
        try {
            const raw = await fs.readFile(ownerPath, 'utf8');
            return JSON.parse(raw) as EmployeeStorageOwner;
        } catch {
            return null;
        }
    }

    private async writeOwnerMarker(baseDir: string, owner: EmployeeStorageOwner) {
        const ownerPath = path.join(baseDir, '.owner.json');
        await fs.writeFile(ownerPath, JSON.stringify(owner, null, 2));
    }

    private async resolveStoredName(targetDir: string, safeOriginalName: string) {
        const targetPath = path.join(targetDir, safeOriginalName);
        try {
            await fs.access(targetPath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            return `${timestamp}-${safeOriginalName}`;
        } catch {
            return safeOriginalName;
        }
    }

    private async upsertMetadata(
        metadataPath: string,
        data: {
            category: EmployeeStorageCategory;
            employeeName: string;
            extractedText: string;
            originalName: string;
            llm?: LlmExtraction | null;
        }
    ) {
        let metadata: EmployeeMetadata = {
            name: data.employeeName,
            skills: [],
            certifications: [],
            experience_years: 0,
            last_update: this.currentDate(),
        };

        try {
            const existing = await fs.readFile(metadataPath, 'utf8');
            const parsed = JSON.parse(existing) as Partial<EmployeeMetadata>;
            metadata = {
                name: parsed.name || metadata.name,
                skills: Array.isArray(parsed.skills) ? parsed.skills : [],
                certifications: Array.isArray(parsed.certifications) ? parsed.certifications : [],
                experience_years: typeof parsed.experience_years === 'number' ? parsed.experience_years : 0,
                last_update: typeof parsed.last_update === 'string' ? parsed.last_update : metadata.last_update,
            };
        } catch {
            // First metadata file creation
        }

        metadata.name = data.employeeName || metadata.name || 'unknown';

        if (data.category === 'CV') {
            const llmSkills = Array.isArray(data.llm?.skills) ? data.llm!.skills! : [];
            const extractedSkills = this.extractSkillsFromText(data.extractedText);
            metadata.skills = this.uniqueValues([...metadata.skills, ...llmSkills, ...extractedSkills]);

            const years = Math.max(
                this.extractExperienceYears(data.extractedText),
                typeof data.llm?.experience_years === 'number' ? data.llm.experience_years : 0
            );
            if (years > 0) {
                metadata.experience_years = Math.max(metadata.experience_years, years);
            }
        }

        if (data.category === 'Certifications') {
            const llmCert = data.llm?.certifications?.[0];
            const cert = llmCert || this.extractCertificationMetadata(data.extractedText, data.originalName);
            if (cert.name) {
                const existingIndex = metadata.certifications.findIndex(
                    (item) => item.name.trim().toLowerCase() === cert.name.trim().toLowerCase()
                );
                if (existingIndex >= 0) {
                    metadata.certifications[existingIndex] = cert;
                } else {
                    metadata.certifications.push(cert);
                }
            }
        }

        metadata.last_update = this.currentDate();
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    }

    private buildSafeFolderName(employeeName?: string, fallbackId?: string) {
        const base = employeeName || fallbackId || 'unknown';
        const normalized = base
            .trim()
            .replace(/\s+/g, ' ')
            .split(' ')
            .map((token) => this.capitalizeToken(token))
            .join('_');
        return this.sanitizeFileName(normalized);
    }

    private async extractDocumentInsights(
        file: Express.Multer.File,
        category: EmployeeStorageCategory
    ): Promise<{ name: string; source: string; text: string }> {
        if (!file?.buffer?.length) {
            return { name: '', source: 'unknown', text: '' };
        }

        const tempPath = path.join(
            tmpdir(),
            `nextrh-${randomUUID()}-${this.sanitizeFileName(file.originalname || 'file')}`
        );
        await fs.writeFile(tempPath, file.buffer);

        try {
            const candidates: Array<{ text: string; source: string }> = [];

            const pymupdfText = await this.tryExtractWithPyMuPDF(tempPath);
            if (pymupdfText) candidates.push({ text: pymupdfText, source: 'pymupdf' });

            const tikaText = await this.tryExtractWithTika(tempPath);
            if (tikaText) candidates.push({ text: tikaText, source: 'tika' });

            if (file.mimetype.startsWith('image/')) {
                const ocrText = await this.tryExtractWithOcr(tempPath);
                if (ocrText) candidates.push({ text: ocrText, source: 'ocr' });
            }

            if (file.mimetype === 'application/pdf' && !candidates.some((c) => c.text.trim().length > 0)) {
                const pdfOcrText = await this.tryExtractPdfWithOcr(tempPath);
                if (pdfOcrText) candidates.push({ text: pdfOcrText, source: 'ocr_pdf' });
            }

            let name = '';
            let source = 'unknown';
            for (const candidate of candidates) {
                const candidateName = this.extractNameFromText(candidate.text);
                if (candidateName) {
                    name = candidateName;
                    source = candidate.source;
                    break;
                }
            }

            const text = candidates.find((item) => item.text.trim().length > 0)?.text || '';
            return { name, source, text };
        } finally {
            await fs.unlink(tempPath).catch(() => undefined);
        }
    }

    private async extractStructuredWithOllama(text: string, category: EmployeeStorageCategory): Promise<LlmExtraction | null> {
        if (!this.isOllamaEnabled() || !text?.trim()) {
            return null;
        }

        const textForPrompt =
            category === 'Certifications'
                ? text.slice(0, 8000)
                : text.slice(0, 20000);
        const prompt = category === 'Certifications'
            ? [
                'Extract structured certification data from the text below.',
                'Return JSON only with this exact shape:',
                '{"name":"", "skills":[], "certifications":[{"name":"","status":"active|expired|unknown","expiration":"YYYY-MM-DD|null"}], "experience_years":0}',
                'Rules:',
                '- name: employee full name if present.',
                '- certifications[0].name: exact certificate title (not filename).',
                '- certifications[0].expiration: MUST be the expiry/end-validity date only.',
                '- Do NOT use issue date / award date / obtained date as expiration.',
                "- Expiration cues: expires, expiry, expiration, valid until, valable jusqu'au, date d'expiration.",
                '- skills and experience_years can be empty/0 for certificates.',
                'If unknown, keep empty string/empty array/null/0.',
                'Text:',
                textForPrompt,
            ].join('\n')
            : [
                'Extract structured CV data from the text below.',
                'Return JSON only with this exact shape:',
                '{"name":"", "skills":[], "certifications":[{"name":"","status":"active|expired|unknown","expiration":"YYYY-MM-DD|null"}], "experience_years":0}',
                'Rules:',
                '- name: employee full name from CV content, not filename.',
                '- skills: concise technology skills list.',
                '- experience_years: integer years of professional experience.',
                '- certifications: include only if clearly present.',
                'If unknown, keep empty string/empty array/null/0.',
                'Text:',
                textForPrompt,
            ].join('\n');

        const url = `${this.getOllamaBaseUrl()}/api/generate`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.getOllamaModel(),
                    prompt,
                    stream: false,
                    format: 'json',
                    options: { temperature: 0 },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                return null;
            }

            const body = (await response.json()) as { response?: string };
            if (!body?.response) {
                return null;
            }

            const parsed = JSON.parse(body.response) as Partial<LlmExtraction>;
            return this.normalizeLlmExtraction(parsed);
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    private normalizeLlmExtraction(raw: Partial<LlmExtraction>): LlmExtraction {
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        const skills = Array.isArray(raw.skills)
            ? this.uniqueValues(raw.skills.filter((item): item is string => typeof item === 'string'))
            : [];

        const certifications = Array.isArray(raw.certifications)
            ? raw.certifications
                .filter((item): item is CertificationMetadata => !!item && typeof item.name === 'string')
                .map((item) => ({
                    name: item.name.trim() || 'Unknown Certification',
                    status: item.status === 'active' || item.status === 'expired' || item.status === 'unknown'
                        ? item.status
                        : 'unknown',
                    expiration: this.normalizeExpiration(item.expiration),
                }))
            : [];

        const experience = typeof raw.experience_years === 'number' && raw.experience_years >= 0 && raw.experience_years <= 60
            ? Math.floor(raw.experience_years)
            : 0;

        return {
            name,
            skills,
            certifications,
            experience_years: experience,
        };
    }

    private normalizeExpiration(value: string | null | undefined) {
        if (!value || typeof value !== 'string') return null;
        const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (iso) return value;

        const alt = value.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
        if (alt) {
            return this.normalizeDate(alt[3], alt[2], alt[1]);
        }
        return null;
    }

    private isOllamaEnabled() {
        return String(process.env.OLLAMA_ENABLED || 'false').toLowerCase() === 'true';
    }

    private getOllamaBaseUrl() {
        if (process.env.OLLAMA_URL) {
            return process.env.OLLAMA_URL;
        }
        return existsSync('/.dockerenv') ? 'http://host.docker.internal:11434' : 'http://localhost:11434';
    }

    private getOllamaModel() {
        return process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
    }

    private async tryExtractWithPyMuPDF(filePath: string) {
        const script = [
            'import sys',
            'import fitz',
            'doc = fitz.open(sys.argv[1])',
            'chunks = []',
            'for page in doc:',
            "  blocks = page.get_text('blocks')",
            '  if blocks:',
            '    blocks = sorted(blocks, key=lambda b: (round(b[1], 1), round(b[0], 1)))',
            "    page_txt = '\\n'.join([(b[4] or '').strip() for b in blocks if len(b) > 4 and (b[4] or '').strip()])",
            '    if page_txt.strip():',
            '      chunks.append(page_txt)',
            '      continue',
            "  words = page.get_text('words')",
            '  if words:',
            '    words = sorted(words, key=lambda w: (round(w[3], 1), round(w[0], 1)))',
            "    chunks.append(' '.join([w[4] for w in words if len(w) > 4]))",
            '  else:',
            "    chunks.append(page.get_text('text'))",
            "txt = '\\n'.join(chunks)",
            'doc.close()',
            'print(txt[:200000])',
        ].join('; ');

        return this.runPythonScript(script, [filePath], 10000);
    }

    private async tryExtractWithTika(filePath: string) {
        const tikaJar = process.env.TIKA_JAR_PATH;
        if (!tikaJar || !existsSync(tikaJar)) {
            return '';
        }

        try {
            const { stdout } = await execFileAsync('java', ['-jar', tikaJar, '-t', filePath], {
                timeout: 12000,
            });
            return (stdout || '').trim();
        } catch {
            return '';
        }
    }

    private async tryExtractWithOcr(filePath: string) {
        const lang = process.env.TESSERACT_LANG || 'eng+fra';
        try {
            const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '-l', lang], { timeout: 12000 });
            return (stdout || '').trim();
        } catch {
            try {
                const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout'], { timeout: 12000 });
                return (stdout || '').trim();
            } catch {
                return '';
            }
        }
    }

    private async tryExtractPdfWithOcr(filePath: string) {
        const script = [
            'import sys, subprocess, tempfile, os, fitz',
            'pdf = fitz.open(sys.argv[1])',
            'texts = []',
            'max_pages = min(3, len(pdf))',
            'for i in range(max_pages):',
            '  page = pdf[i]',
            '  pix = page.get_pixmap(matrix=fitz.Matrix(2,2))',
            "  tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)",
            '  try:',
            '    pix.save(tmp.name)',
            "    lang = sys.argv[2] if len(sys.argv) > 2 else ''",
            "    cmd = ['tesseract', tmp.name, 'stdout'] + (['-l', lang] if lang else [])",
            "    out = subprocess.run(cmd, capture_output=True, text=True)",
            '    texts.append(out.stdout or "")',
            '  finally:',
            '    tmp.close()',
            '    try: os.unlink(tmp.name)',
            '    except: pass',
            'pdf.close()',
            "print('\\n'.join(texts)[:200000])",
        ].join('; ');

        const lang = process.env.TESSERACT_LANG || 'eng+fra';
        return this.runPythonScript(script, [filePath, lang], 20000);
    }

    private async runPythonScript(script: string, args: string[], timeout = 10000) {
        const candidates = ['python', 'python3'];
        for (const bin of candidates) {
            try {
                const { stdout } = await execFileAsync(bin, ['-c', script, ...args], { timeout });
                const text = (stdout || '').trim();
                if (text) return text;
            } catch {
                // Try next Python binary
            }
        }
        return '';
    }

    private extractNameFromText(text: string) {
        if (!text) return '';

        const lines = text
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 80);

        const fromTitle = this.extractNameFromTitleLine(lines.slice(0, 12));
        if (fromTitle) {
            return fromTitle;
        }

        const stopwords = new Set([
            'curriculum',
            'vitae',
            'resume',
            'certificate',
            'certification',
            'education',
            'experience',
            'skills',
            'profile',
            'contact',
            'summary',
        ]);

        const scored = lines
            .map((line) => {
                const cleaned = line
                    .replace(/[0-9]/g, ' ')
                    .replace(/[^\p{L}\s'-]/gu, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!cleaned || cleaned.length < 5 || cleaned.length > 60) {
                    return { line: '', score: 0 };
                }

                const words = cleaned.split(' ').filter(Boolean);
                if (words.length < 2 || words.length > 4) {
                    return { line: '', score: 0 };
                }

                if (words.some((word) => stopwords.has(word.toLowerCase()))) {
                    return { line: '', score: 0 };
                }

                const capScore = words.filter((word) => /^\p{Lu}[\p{L}'-]+$/u.test(word) || /^\p{Lu}{2,}$/u.test(word)).length;
                const alphaScore = words.filter((word) => /^[\p{L}'-]+$/u.test(word)).length;
                const score = capScore * 2 + alphaScore;
                return { line: words.join(' '), score };
            })
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);

        if (!scored.length) return '';
        return scored[0].line
            .split(' ')
            .map((token) => this.capitalizeToken(token))
            .join(' ');
    }

    private extractNameFromTitleLine(lines: string[]) {
        const noisePattern = /\b(cv|resume|curriculum vitae|profile|profil|certification|certificate|certificat)\b/gi;
        const headingStop = new Set([
            'experience',
            'education',
            'skills',
            'contact',
            'profile',
            'summary',
            'competences',
            'formation',
            'expérience',
            'coordonnees',
        ]);

        // First valid title line is considered the employee name.
        for (const line of lines.slice(0, 8)) {
            const cleaned = line
                .replace(noisePattern, ' ')
                .replace(/[0-9]/g, ' ')
                .replace(/[^\p{L}\s'-]/gu, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!cleaned) continue;

            const words = cleaned.split(' ').filter(Boolean);
            if (words.length < 2 || words.length > 5) continue;
            if (headingStop.has(cleaned.toLowerCase())) continue;

            const validWords = words.filter((word) => /^[\p{L}'-]+$/u.test(word));
            if (validWords.length !== words.length) continue;

            return words.map((token) => this.capitalizeToken(token)).join(' ');
        }
        return '';
    }

    private extractSkillsFromText(text: string) {
        if (!text) return [];

        const catalog: Array<{ key: string; label: string }> = [
            { key: 'python', label: 'Python' },
            { key: 'aws', label: 'AWS' },
            { key: 'ai', label: 'AI' },
            { key: 'machine learning', label: 'Machine Learning' },
            { key: 'deep learning', label: 'Deep Learning' },
            { key: 'java', label: 'Java' },
            { key: 'typescript', label: 'TypeScript' },
            { key: 'javascript', label: 'JavaScript' },
            { key: 'react', label: 'React' },
            { key: 'node', label: 'Node.js' },
            { key: 'docker', label: 'Docker' },
            { key: 'kubernetes', label: 'Kubernetes' },
            { key: 'sql', label: 'SQL' },
            { key: 'azure', label: 'Azure' },
            { key: 'gcp', label: 'GCP' },
            { key: 'power bi', label: 'Power BI' },
            { key: 'intelligence artificielle', label: 'AI' },
            { key: 'apprentissage automatique', label: 'Machine Learning' },
            { key: 'apprentissage profond', label: 'Deep Learning' },
            { key: 'informatique decisionnelle', label: 'Power BI' },
        ];

        const normalized = this.normalizeForSearch(text);
        const found = catalog
            .filter((item) => this.hasToken(normalized, this.normalizeForSearch(item.key)))
            .map((item) => item.label);
        return this.uniqueValues(found);
    }

    private extractExperienceYears(text: string) {
        if (!text) return 0;

        const patterns = [
            /(\d{1,2})\+?\s*(?:years|year|yrs|yr)\b/i,
            /(\d{1,2})\+?\s*(?:ans|an)\b/i,
            /(\d{1,2})\+?\s*(?:years|ans)\s+(?:of\s+)?(?:experience|exp(?:e|é)rience)\b/i,
            /(?:experience|exp(?:e|é)rience)\s*[:\-]?\s*(\d{1,2})/i,
            /(\d{1,2})\s*(?:ans|an)\s+d['’]?(?:exp(?:e|é)rience)\b/i,
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match?.[1]) {
                const value = Number(match[1]);
                if (!Number.isNaN(value) && value >= 0 && value <= 60) {
                    return value;
                }
            }
        }
        return 0;
    }

    private extractCertificationMetadata(text: string, originalName: string): CertificationMetadata {
        const name = this.extractCertificationNameFromText(text) || 'Unknown Certification';

        return {
            name,
            status: this.resolveCertificationStatus(text),
            expiration: this.extractExpirationDate(text),
        };
    }

    private extractCertificationNameFromText(text: string) {
        if (!text) return '';
        const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 50);

        for (const line of lines) {
            const normalized = line.replace(/\s+/g, ' ').trim();
            if (normalized.length < 4 || normalized.length > 80) continue;
            if (/certificate|certification|certified|certificat|attestation/i.test(normalized)) {
                return normalized;
            }
        }

        for (let i = 0; i < lines.length - 1; i++) {
            const current = lines[i].replace(/\s+/g, ' ').trim();
            const next = lines[i + 1].replace(/\s+/g, ' ').trim();
            if (!next || next.length < 4 || next.length > 80) continue;
            if (/certificate|certification|certified|certificat|attestation|awarded to|delivre a|délivré à/i.test(current)) {
                if (!/name|nom|id|credential|reference/i.test(next)) {
                    return next;
                }
            }
        }

        for (const line of lines.slice(0, 12)) {
            const normalized = line.replace(/\s+/g, ' ').trim();
            if (normalized.length < 5 || normalized.length > 70) continue;
            const normalizedSearch = this.normalizeForSearch(normalized);
            if (/^(name|nom|issued to|delivre a)\b/i.test(normalizedSearch)) {
                continue;
            }

            const words = normalized.split(' ').filter(Boolean);
            if (words.length < 2 || words.length > 8) continue;
            if (words.some((w) => /[0-9]/.test(w))) continue;
            return normalized;
        }
        return '';
    }

    private resolveCertificationStatus(text: string): CertificationMetadata['status'] {
        const expiration = this.extractExpirationDate(text);
        if (!expiration) return 'unknown';
        const today = this.currentDate();
        return expiration < today ? 'expired' : 'active';
    }

    private extractExpirationDate(text: string): string | null {
        if (!text) return null;
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const expiryHints = /expires?|expiry|expiration|valid until|valable jusqu|date d['’]expiration|expire le|expir/i;

        for (const line of lines) {
            const normalized = line.replace(/\s+/g, ' ');
            if (!expiryHints.test(normalized)) continue;

            const iso = normalized.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
            if (iso) return this.normalizeDate(iso[1], iso[2], iso[3]);

            const eu = normalized.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
            if (eu) return this.normalizeDate(eu[3], eu[2], eu[1]);
        }

        const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
        if (iso) {
            return this.normalizeDate(iso[1], iso[2], iso[3]);
        }

        const eu = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
        if (eu) {
            return this.normalizeDate(eu[3], eu[2], eu[1]);
        }

        return null;
    }

    private normalizeDate(year: string, month: string, day: string) {
        const y = Number(year);
        const m = Number(month);
        const d = Number(day);
        if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
        if (m < 1 || m > 12 || d < 1 || d > 31) return null;
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    private extractNameFromFilename(filename: string) {
        const base = filename.replace(/\.[^.]+$/, '');
        const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';

        const tokens = cleaned.split(' ').filter((token) => token.length > 0);
        const filtered = tokens.filter(
            (token) =>
                ![
                    'cv',
                    'resume',
                    'curriculum',
                    'vitae',
                    'certification',
                    'certificate',
                    'certif',
                    'diploma',
                ].includes(token.toLowerCase())
        );
        if (filtered.length >= 2) {
            return filtered.map((token) => this.capitalizeToken(token)).join(' ');
        }
        return '';
    }

    private capitalizeToken(input: string) {
        if (!input) return '';
        return input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
    }

    private sanitizeFileName(input: string) {
        return input.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    private resolveExtension(file: Express.Multer.File, safeOriginalName: string) {
        const extFromName = path.extname(safeOriginalName);
        if (extFromName) {
            return extFromName.toLowerCase();
        }

        const byMime: Record<string, string> = {
            'application/pdf': '.pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'image/png': '.png',
            'image/jpeg': '.jpg',
        };

        return byMime[file.mimetype] || '';
    }

    private uniqueValues(values: string[]) {
        return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
    }

    private normalizeForSearch(value: string) {
        return value
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private hasToken(haystack: string, token: string) {
        if (!token) return false;
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
        return re.test(haystack);
    }

    private async readMetadataFile(metadataPath: string) {
        try {
            const raw = await fs.readFile(metadataPath, 'utf8');
            return JSON.parse(raw) as Partial<EmployeeMetadata>;
        } catch {
            return null;
        }
    }

    private currentDate() {
        return new Date().toISOString().slice(0, 10);
    }

    private getStorageRoot() {
        return path.join(process.cwd(), 'file-storage', 'CV_Database');
    }
}


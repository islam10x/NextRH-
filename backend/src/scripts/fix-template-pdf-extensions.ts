import 'reflect-metadata';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

import { AppDataSource } from '../database/data-source';
import { CvTemplate } from '../cv-templates/entities/cv-template.entity';

const PDF_MAGIC = '%PDF';

const resolveWorkspaceRoot = () => {
    if (process.env.PROJECT_ROOT) {
        return path.resolve(process.env.PROJECT_ROOT);
    }

    let current = path.resolve(__dirname);
    while (true) {
        const maybeRoot = current;
        if (
            existsSync(path.join(maybeRoot, 'backend')) &&
            existsSync(path.join(maybeRoot, 'file-storage'))
        ) {
            return maybeRoot;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    // Fallback: backend/src/scripts -> ../../..
    return path.resolve(__dirname, '..', '..', '..');
};

const isPdfHeader = async (filePath: string) => {
    const fd = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(4);
        await fd.read(buffer, 0, 4, 0);
        return buffer.toString('utf8') === PDF_MAGIC;
    } finally {
        await fd.close();
    }
};

const ensureUniqueTarget = async (basePath: string) => {
    if (!existsSync(basePath)) return basePath;
    const dir = path.dirname(basePath);
    const parsed = path.parse(basePath);
    const stamped = path.join(dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
    return stamped;
};

const main = async () => {
    const root = resolveWorkspaceRoot();
    await AppDataSource.initialize();
    const repo = AppDataSource.getRepository(CvTemplate);

    const templates = await repo.find();
    let updated = 0;
    let renamed = 0;

    for (const template of templates) {
        const filePath = template.filePath;
        if (!filePath) continue;

        const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(root, filePath);
        const parsed = path.parse(absPath);

        if (existsSync(absPath)) {
            const isPdf = await isPdfHeader(absPath);
            if (isPdf && parsed.ext.toLowerCase() !== '.pdf') {
                const targetPath = await ensureUniqueTarget(
                    path.join(parsed.dir, `${parsed.name}.pdf`),
                );
                await fs.rename(absPath, targetPath);
                template.filePath = path.relative(root, targetPath);
                if (template.originalFilename && template.originalFilename.toLowerCase().endsWith('.docx')) {
                    template.originalFilename = template.originalFilename.replace(/\.docx$/i, '.pdf');
                }
                await repo.save(template);
                renamed += 1;
                updated += 1;
                continue;
            }
            continue;
        }

        // If file is missing, try swapping extension to .pdf
        if (parsed.ext.toLowerCase() === '.docx') {
            const candidate = path.join(parsed.dir, `${parsed.name}.pdf`);
            if (existsSync(candidate)) {
                template.filePath = path.relative(root, candidate);
                if (template.originalFilename && template.originalFilename.toLowerCase().endsWith('.docx')) {
                    template.originalFilename = template.originalFilename.replace(/\.docx$/i, '.pdf');
                }
                await repo.save(template);
                updated += 1;
            }
        }
    }

    await AppDataSource.destroy();
    // eslint-disable-next-line no-console
    console.log(`Template cleanup complete. Renamed files: ${renamed}. Updated records: ${updated}.`);
};

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Template cleanup failed:', err);
    process.exit(1);
});

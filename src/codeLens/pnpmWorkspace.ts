import path from 'node:path';

import { globby } from 'globby';
import type { CancellationToken, CodeLensProvider, TextDocument, Event, Position } from 'vscode';
import { window, CodeLens, EventEmitter, Range, workspace } from 'vscode';
import { Parser } from 'yaml';

const packagesLiteral = 'packages';
const ignoredGlobs = ['!**/node_modules'];

function sourceToString(source: string) {
    if (
        (source[0] === "'" && source.at(-1) === "'") ||
        (source[0] === '"' && source.at(-1) === '"')
    )
        return source.slice(1, -1);
    else return source;
}

export class PnpmWorkspaceCodeLensProvider implements CodeLensProvider {
    private _document: TextDocument | undefined;
    private _negativeGlobs: string[] = [];
    private _codeLensData = new Map<
        CodeLens,
        {
            type: 'all' | 'include' | 'exclude';
            position: Position;
            getPackagesPromise: Promise<string[]>;
        }
    >();

    private _onDidChangeCodeLenses: EventEmitter<void> = new EventEmitter<void>();
    public readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        workspace.onDidChangeTextDocument((e) => {
            if (e.document === this._document) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    private _reset(document: TextDocument) {
        this._document = document;
        this._negativeGlobs = [];
        this._codeLensData.clear();
    }

    async provideCodeLenses(
        document: TextDocument,
        _token: CancellationToken,
    ): Promise<CodeLens[] | undefined> {
        this._reset(document);

        const isOnlyOneRootWorkspace = workspace.workspaceFolders?.length === 1;
        if (!isOnlyOneRootWorkspace) {
            return;
        }
        const cwd = workspace.workspaceFolders![0].uri.fsPath;

        const source = document.getText();
        let yamlDoc: any | undefined;
        const parser = new Parser();
        try {
            for (const token of parser.parse(source)) {
                if (token.type === 'document') {
                    yamlDoc = token;
                    break;
                }
            }
        } catch (error) {
            console.error(error);
            window.showErrorMessage('parse pnpm-workspace.yaml failed!');
            return;
        }
        if (!yamlDoc) return;

        const packagesNode = yamlDoc.value?.items.find(
            (token: any) => token.key?.source === packagesLiteral,
        ) as any | undefined;
        if (!packagesNode) return;

        const patternList: Array<{
            isNegated: boolean;
            range: Range;
            pattern: string;
        }> = [];
        for (const globNode of packagesNode.value.items) {
            if (globNode.value.type !== 'single-quoted-scalar') continue;

            const glob = sourceToString(globNode.value.source);
            if (glob.startsWith('!')) {
                this._negativeGlobs.push(glob);
            }

            const start = document.positionAt(globNode.value!.offset);
            const end = document.positionAt(globNode.value!.offset + glob.length);
            patternList.push({
                isNegated: glob.startsWith('!'),
                range: new Range(start, end),
                pattern: glob,
            });
        }

        const codeLensList: CodeLens[] = [];
        const totalPackages = new Set<string>([]);
        const promises: Array<Promise<string[]>> = [];
        for (const item of patternList.values()) {
            const codeLens = new CodeLens(item.range);
            codeLensList.push(codeLens);
            const getPackagesPromise = (async () => {
                let matchedPackages: string[] = [];
                if (!item.isNegated) {
                    const slash = item.pattern.endsWith('/') ? '' : '/';
                    const packageJSONGlob = `${item.pattern}${slash}package.json`;
                    const globs = [packageJSONGlob, ...this._negativeGlobs, ...ignoredGlobs];
                    matchedPackages = await globby(globs, { cwd });
                } else {
                    const glob = item.pattern.slice(1);
                    const slash = glob.endsWith('/') ? '' : '/';
                    const packageJSONGlob = `${glob}${slash}package.json`;
                    matchedPackages = await globby([packageJSONGlob, ...ignoredGlobs], { cwd });
                }
                matchedPackages = matchedPackages.map((pkg) => {
                    const absPath = path.resolve(cwd, pkg);
                    if (!item.isNegated) {
                        totalPackages.add(absPath);
                    }
                    return absPath;
                });
                return matchedPackages;
            })();
            if (!item.isNegated) {
                promises.push(getPackagesPromise);
            }
            this._codeLensData.set(codeLens, {
                type: item.isNegated ? 'exclude' : 'include',
                position: item.range.start,
                getPackagesPromise,
            });
        }

        const start = document.positionAt(packagesNode.key!.offset);
        const end = document.positionAt(packagesNode.key!.offset + packagesLiteral.length);
        const codeLens = new CodeLens(new Range(start, end));
        codeLensList.push(codeLens);
        this._codeLensData.set(codeLens, {
            type: 'all',
            position: start,
            getPackagesPromise: (async () => {
                await Promise.all(promises);
                return [...totalPackages];
            })(),
        });
        return codeLensList;
    }

    async resolveCodeLens(
        codeLens: CodeLens,
        _token: CancellationToken,
    ): Promise<CodeLens | undefined> {
        const data = this._codeLensData.get(codeLens);
        if (!data) return;

        const packages = await data.getPackagesPromise;
        const packagesCount = packages.length;
        const title = (data.type === 'exclude' ? '- ' : '') + packagesCount;

        return {
            ...codeLens,
            command: {
                title,
                command: 'package-manager-enhancer.showReferencesInPanel',
                arguments: [this._document!.uri, data.position, packages],
            },
        };
    }
}

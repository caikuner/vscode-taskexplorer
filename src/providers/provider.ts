
import * as util from "../common/utils";
import * as log from "../common/log";
import constants from "../common/constants";
import { configuration } from "../common/configuration";
import { filesCache, removeFileFromCache } from "../cache";
import { Uri, Task, WorkspaceFolder, TaskProvider } from "vscode";


export abstract class TaskExplorerProvider implements TaskProvider
{
    abstract createTask(target: string, cmd: string | undefined, folder: WorkspaceFolder, uri: Uri, xArgs?: string[], logPad?: string): Task | undefined;
    abstract getDocumentPosition(taskName: string | undefined, documentText: string | undefined): number;
    abstract readUriTasks(uri: Uri, logPad: string): Promise<Task[]>;


    public cachedTasks: Task[] | undefined;
    public invalidating = false;
    public providerName = "***";

    private queue: Uri[];


    constructor(name: string) {
        this.providerName = name;
        this.queue = [];
    }


    getDocumentPositionLine(lineName: string, scriptName: string, documentText: string, advance = 0, start = 0, skipQuotes = false): number
    {
        //
        // TODO - This is crap, use regex to detect spaces between quotes
        //
        let idx = documentText.indexOf(lineName + (!skipQuotes ? "\"" : "") + scriptName + (!skipQuotes ? "\"" : ""), start);
        if (idx === -1)
        {
            idx = documentText.indexOf(lineName + (!skipQuotes ? "'" : "") + scriptName + (!skipQuotes ? "'" : ""), start);
        }
        if (advance !== 0 && idx !== -1)
        {
            idx += advance;
        }
        return idx;
    }


    /**
     * Override for external providers or custom globs (for ant/bash)
     *
     * @since 2.6.3
     */
    public getGlobPattern(subType?: string)
    {
        return constants[`GLOB_${this.providerName.replace(/\-/g, "").toUpperCase()}`];
    }


    public async provideTasks()
    {
        log.methodStart(`provide ${this.providerName} tasks`, 1, "", true);
        if (!this.cachedTasks) {
            this.cachedTasks = await this.readTasks("   ");
        }
        log.methodDone(`provide ${this.providerName} tasks`, 1, "", true);
        return this.cachedTasks;
    }


    protected async readTasks(logPad: string): Promise<Task[]>
    {
        const allTasks: Task[] = [];
        const visitedFiles: Set<string> = new Set();
        const paths = filesCache.get(this.providerName),
              enabled = configuration.get<boolean>(util.getTaskTypeEnabledSettingName(this.providerName));

        log.methodStart(`detect ${this.providerName} files`, 1, logPad, true, [["enabled", enabled]]);

        if (enabled && paths)
        {
            for (const fObj of paths)
            {
                if (!util.isExcluded(fObj.uri.path) && !visitedFiles.has(fObj.uri.fsPath) && util.pathExists(fObj.uri.fsPath))
                {
                    visitedFiles.add(fObj.uri.fsPath);
                    const tasks = await this.readUriTasks(fObj.uri, logPad + "   ");
                    log.write(`   processed ${this.providerName} file`, 3, logPad);
                    log.value("      file", fObj.uri.fsPath, 3, logPad);
                    log.value("      targets in file", tasks.length, 3, logPad);
                    allTasks.push(...tasks);
                }
            }
        }

        log.methodDone(`detect ${this.providerName} files`, 1, logPad, true, [["# of tasks", allTasks.length]]);
        return allTasks;
    }


    public resolveTask(_task: Task): Task | undefined
    {
        return undefined;
    }


    public async invalidate(uri?: Uri, logPad = ""): Promise<void>
    {
        log.methodStart(`invalidate ${this.providerName} tasks cache`, 1, logPad, true,
            [["uri", uri?.path], ["has cached tasks", !!this.cachedTasks]]
        );

        if (uri && this.invalidating) {
            this.queue.push(uri);
            return;
        }
        this.invalidating = true;

        if (this.cachedTasks)
        {
            const rmvTasks: Task[] = [];

            if (uri)
            {
                const pathExists = util.pathExists(uri.fsPath);

                for (const each of this.cachedTasks)
                {
                    const cstDef = each.definition;
                    if (cstDef.uri && (cstDef.uri.fsPath === uri.fsPath || !util.pathExists(cstDef.uri.fsPath)))
                    {
                        rmvTasks.push(each);
                    }
                }

                for (const each of rmvTasks)
                {
                    log.write("   removing old task " + each.name, 2, logPad);
                    util.removeFromArray(this.cachedTasks, each);
                }

                if (pathExists && util.existsInArray(configuration.get("exclude", []), uri.path) === false)
                {
                    const tasks = await this.readUriTasks(uri, logPad + "   ");
                    //
                    // If the implementation of the readUri() method awaits, it can theoretically reset
                    // this.cachedTasks under certain circumstances via invalidation by the tree that's
                    // called into by the main VSCode thread. So ensure it's defined before the push()...
                    //
                    this.cachedTasks?.push(...tasks);
                }
                else if (!pathExists) {
                    await removeFileFromCache(this.providerName, uri, "   ");
                }

                this.cachedTasks = this.cachedTasks && this.cachedTasks.length > 0 ? this.cachedTasks : undefined;
            }
            else {
                this.cachedTasks = undefined;
            }
        }

        log.methodDone(`invalidate ${this.providerName} tasks cache`, 1, logPad);
        this.invalidating = false;
        await this.processQueue();
    }


    private async processQueue()
    {
        if (this.queue.length > 0) {
            await this.invalidate(this.queue.shift());
        }
    }

}

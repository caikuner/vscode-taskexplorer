
import { workspace, window, RelativePattern, WorkspaceFolder, Uri, StatusBarAlignment } from "vscode";
import { log, logValue, timeout, getExcludesGlob, isExcluded, properCase } from "./util";
import { configuration } from "./common/configuration";
import { utils } from "mocha";

export let filesCache: Map<string, Set<any>> = new Map();
export let cacheBuilding = false;

let cancel = false;


export async function cancelBuildCache(wait?: boolean)
{
    let waitCount = 20;
    if (!cacheBuilding) {
        return;
    }
    cancel = true;
    while (wait && cacheBuilding && waitCount > 0) {
        waitCount--;
        await timeout(500);
    }
}


export async function waitForCache()
{
    while (cacheBuilding) {
        await timeout(100);
    }
}


export async function rebuildCache()
{
    filesCache.clear();
    await addFolderToCache();
}


export async function buildCache(taskAlias: string, taskType: string, fileBlob: string, wsfolder?: WorkspaceFolder | undefined, setCacheBuilding = true)
{
    log("Start cache building");
    logValue("   task alias", taskAlias, 2);
    logValue("   task type", taskType, 2);
    logValue("   blob", fileBlob, 2);
    logValue("   folder", !wsfolder ? "entire workspace" : wsfolder.name);
    logValue("   setCacheBuilding", setCacheBuilding.toString(), 2);

    //
    // If buildCache is already running in another scope, then cancel and wait
    //
    // if (cacheBuilding === true) {
    //     await cancelBuildCache();
    // }

    if (setCacheBuilding) {
        cacheBuilding = true;
    }

    if (!filesCache.get(taskAlias)) {
        filesCache.set(taskAlias, new Set());
    }
    const fCache = filesCache.get(taskAlias);
    let dispTaskType = properCase(taskType);
    if (dispTaskType.indexOf("Ant") !== -1) {
        dispTaskType = "Ant";
    }

    function statusString(msg: string, statusLength = 0)
    {
        if (msg)
        {
            if (statusLength > 0)
            {
                if (msg.length < statusLength)
                {
                    for (let i = msg.length; i < statusLength; i++) {
                        msg += " ";
                    }
                }
                else {
                    msg = msg.substring(0, statusLength - 3) + "...";
                }
            }
            return "$(loading~spin) " + msg;
        }

        return "";
    }

    const statusBarSpace = window.createStatusBarItem(StatusBarAlignment.Left, -10000);
    statusBarSpace.tooltip = "Task Explorer is building the task cache";
    statusBarSpace.show();

    if (!wsfolder)
    {
        log("Build cache - Scan all projects for taskType '" + taskType + "' (" + dispTaskType + ")");

        if (workspace.workspaceFolders)
        {
            try {
                for (const folder of workspace.workspaceFolders)
                {
                    if (cancel) {
                        cancel = false;
                        if (setCacheBuilding) {
                            cacheBuilding = false;
                        }
                        statusBarSpace.dispose();
                        return;
                    }

                    log("   Scan project " + folder.name + " for " + dispTaskType + " tasks");
                    statusBarSpace.text = statusString("Scanning for " + dispTaskType + " tasks in project " + folder.name, 50);
                    const relativePattern = new RelativePattern(folder, fileBlob);
                    const paths = await workspace.findFiles(relativePattern, getExcludesGlob(folder));
                    for (const fpath of paths)
                    {
                        if (cancel) {
                            cancel = false;
                            if (setCacheBuilding) {
                                cacheBuilding = false;
                            }
                            statusBarSpace.dispose();
                            return;
                        }
                        if (!isExcluded(fpath.path)) {
                            fCache.add({
                                uri: fpath,
                                folder
                            });
                            logValue("   Added to cache", fpath.fsPath, 2);
                        }
                    }
                }
            // tslint:disable-next-line: no-empty
            } catch (error) {}
        }
    }
    else
    {
        log("Build cache - Scan project '" + wsfolder.name + "' for taskType '" + taskType + "'");
        statusBarSpace.text = statusString("Scanning for tasks in project " + wsfolder.name);

        const relativePattern = new RelativePattern(wsfolder, fileBlob);
        const paths = await workspace.findFiles(relativePattern, getExcludesGlob(wsfolder));
        for (const fpath of paths)
        {
            if (cancel) {
                cancel = false;
                if (setCacheBuilding) {
                    cacheBuilding = false;
                }
                statusBarSpace.dispose();
                return;
            }
            if (!isExcluded(fpath.path)) {
            // if (!isExcluded(fpath.path) && !fCache.has(fpath)) {
                fCache.add({
                    uri: fpath,
                    folder: wsfolder
                });
                logValue("   Added to cache", fpath.fsPath, 2);
            }
        }
    }

    statusBarSpace.dispose();
    log("Cache building complete");

    cancel = false;
    if (setCacheBuilding) {
        cacheBuilding = false;
    }
}


export async function addFileToCache(taskAlias: string, uri: Uri)
{
    if (!filesCache.get(taskAlias)) {
        filesCache.set(taskAlias, new Set());
    }
    const taskCache = filesCache.get(taskAlias);
    taskCache.add({
        uri,
        folder: workspace.getWorkspaceFolder(uri)
    });
}


export async function removeFileFromCache(taskAlias: string, uri: Uri)
{
    if (!filesCache.get(taskAlias)) {
        return;
    }
    const taskCache = filesCache.get(taskAlias);
    const toRemove = [];
    taskCache.forEach((item) =>
    {
        if (item.uri.fsPath === uri.fsPath) {
            toRemove.push(item);
        }
    });
    if (toRemove.length > 0) {
        for (const tr in toRemove) {
            taskCache.delete(toRemove[tr]);
        }
    }

}


export async function addFolderToCache(folder?: WorkspaceFolder | undefined)
{
    cacheBuilding = true;
    log("Add folder to cache");
    logValue("   folder", !folder ? "entire workspace" : folder.name);

    if (configuration.get<boolean>("enableAnt")) {
        await buildCache("ant", "ant", "**/[Bb]uild.xml", folder, false);
        const includeAnt: string[] = configuration.get("includeAnt");
        if (includeAnt && includeAnt.length > 0) {
            for (let i = 0; i < includeAnt.length; i++) {
                await buildCache("ant", "ant-" + includeAnt[i], includeAnt[i], folder, false);
            }
        }
    }

    if (configuration.get<boolean>("enableAppPublisher")) {
        await buildCache("app-publisher", "app-publisher", "**/.publishrc*", folder, false);
    }

    if (configuration.get<boolean>("enableBash")) {
        await buildCache("script", "bash", "**/*.[Ss][Hh]", folder, false);
    }

    if (configuration.get<boolean>("enableBatch")) {
        await buildCache("script", "batch", "**/*.[Bb][Aa][Tt]", folder, false);
        await buildCache("script", "batch", "**/*.[Cc][Mm][Dd]", folder, false);
    }

    if (configuration.get<boolean>("enableGradle")) {
        await buildCache("gradle", "gradle", "**/*.[Gg][Rr][Aa][Dd][Ll][Ee]", folder, false);
    }

    if (configuration.get<boolean>("enableGrunt")) {
        await buildCache("grunt", "grunt", "**/[Gg][Rr][Uu][Nn][Tt][Ff][Ii][Ll][Ee].[Jj][Ss]", folder, false);
    }

    if (configuration.get<boolean>("enableGulp")) {
        await buildCache("gulp", "gulp", "**/[Gg][Uu][Ll][Pp][Ff][Ii][Ll][Ee].[Jj][Ss]", folder, false);
    }

    if (configuration.get<boolean>("enableMake")) {
        await buildCache("make", "make", "**/[Mm]akefile", folder, false);
    }

    if (configuration.get<boolean>("enableNpm")) {
        await buildCache("npm", "npm", "**/package.json", folder, false);
    }

    if (configuration.get<boolean>("enableNsis")) {
        await buildCache("script", "nsis", "**/*.[Nn][Ss][Ii]", folder, false);
    }

    if (configuration.get<boolean>("enablePerl")) {
        await buildCache("script", "perl", "**/*.[Pp][Ll]", folder, false);
    }

    if (configuration.get<boolean>("enablePowershell")) {
        await buildCache("script", "powershell", "**/*.[Pp][Ss]1", folder, false);
    }

    if (configuration.get<boolean>("enablePython")) {
        await buildCache("script", "python", "**/[Ss][Ee][Tt][Uu][Pp].[Pp][Yy]", folder, false);
    }

    if (configuration.get<boolean>("enableRuby")) {
        await buildCache("script", "ruby", "**/*.[Rr][Bb]", folder, false);
    }

    if (configuration.get<boolean>("enableTsc")) {
        await buildCache("tsc", "tsc", "**/tsconfig.json", folder, false);
    }

    if (configuration.get<boolean>("enableWorkspace")) {
        await buildCache("workspace", "workspace", "**/.vscode/tasks.json", folder, false);
    }

    cacheBuilding = false;
    log("Add folder to cache complete");
}


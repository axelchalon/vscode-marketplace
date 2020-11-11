import * as vscode from 'vscode';
import { BehaviorSubject, of, combineLatest } from 'rxjs';
import { tryShortname } from '../../util';
import { switchMap, tap } from 'rxjs/operators';
import Nodes, {Node} from '../../nodes/Nodes';

const path = require('path');
const fs = require('fs');

export class NodesProvider implements vscode.TreeDataProvider<NodeTreeItem> {
  nodeTreeItems: NodeTreeItem[] = [];

  private _onDidChangeTreeData: vscode.EventEmitter<NodeTreeItem | undefined> = new vscode.EventEmitter<NodeTreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<NodeTreeItem | undefined> = this._onDidChangeTreeData.event;

  constructor(nodes: Nodes, selectedNode$: BehaviorSubject<Node | null>) {
    nodes.nodes$.subscribe((nodes: Node[]) => {

      this.nodeTreeItems = nodes.map((node: Node) => {
        return new NodeTreeItem(node);
      });

      this.changeSelected(selectedNode$.getValue()?.nodePath || null);
      this._onDidChangeTreeData.fire();
    });

    selectedNode$.subscribe(node => {
      this.changeSelected(node?.nodePath || null);
    });
  }

  changeSelected(selectedNodePath: string | null) {
    this.nodeTreeItems.forEach((nodeTreeItem) => {
      if (nodeTreeItem.nodePath === selectedNodePath)
        nodeTreeItem.select();
      else
        nodeTreeItem.unselect();
    });
    this._onDidChangeTreeData.fire();

  }

  getTreeItem(element: NodeTreeItem): NodeTreeItem | Thenable<NodeTreeItem> {
    return element;
  }

  getChildren(element?: NodeTreeItem | undefined): vscode.ProviderResult<NodeTreeItem[]> {
    if (element === undefined) {
      return this.nodeTreeItems;
    }
    return element.children;
  }
}

export class NodeTreeItem extends vscode.TreeItem {
  children: undefined;
  nodePath: string;

  static create(info: Node) {
    return new this(info);
  }

  constructor(node: Node) {
    const { nodePath } = node;
    super(
      tryShortname(nodePath),
      vscode.TreeItemCollapsibleState.None);
    this.nodePath = nodePath;
    this.command = {
      command: "substrateNodes.selectNode",
      title: "Select Node",
      arguments: [this]
    };
  }

  select() {
    this.label = '▶️ ' + tryShortname(this.nodePath);
  }

  unselect() {
    this.label = tryShortname(this.nodePath);
  }
}

// Prompt the user to select a node among a list
async function quickPickNodePath(nodes: Nodes) {
  let nodePaths = nodes.nodes$.getValue().map((node: Node) => node.nodePath);

  if (nodePaths.length === 1)
    return nodePaths[0];

  if (nodePaths.length === 0) {
    vscode.window.showErrorMessage('No node was found in the workspace.');
    return Promise.reject();
  }

  const nodesReadable = nodePaths.map(n => tryShortname(n));

  const pick = await vscode.window.showQuickPick(nodesReadable, { placeHolder: "Please choose a node." });
  if (pick === undefined)
    return Promise.reject();

  return nodePaths[nodesReadable.findIndex(x => x === pick)];
}

function getCargoName(directory: string) {
  const toml = fs.readFileSync(path.join(directory,'Cargo.toml')).toString();
  const ap = toml.match(/name ?= ?'(.+)'/);
  if (ap)
    return ap[1];
  else return toml.match(/name ?= ?"(.+)"/)[1];
}

function getWorkspaceRoot(directory: string) {
  let currDir = directory;
  do {
    if (fs.existsSync(path.join(currDir, 'Cargo.lock')))
      return currDir;
    currDir = path.join(currDir, '..');
  } while (currDir.split(path.sep).length > 0)
  throw new Error('No workspace root was found');
}

export function setUpNodesTreeView(nodes: Nodes, processes: any) {

    // Can be called by the NodesProvider, in which case a NodeTreeItem is provided;
    // or remotely (across iframe in Substrate Playground), in which case we provide
    // the path of the node to run, and optional additional flags.
    vscode.commands.registerCommand("substrate.startNode", async (nodePathLike?: string | NodeTreeItem, _flags?: string | string[], options: any = {compile: false}) => {
      try {
      let nodePath = nodePathLike instanceof NodeTreeItem ? nodePathLike.nodePath : nodePathLike;
      if (nodePath) {
        selectedNodePath$.next(nodePath); // select the item we launch the command on
      }
      const defNodePath = nodePath || await quickPickNodePath(nodes); // e.g. When run through Command Palette
      const term = vscode.window.createTerminal({ name: 'Start node ' + tryShortname(defNodePath), cwd: defNodePath });

      const flags = _flags ? (Array.isArray(_flags) ? _flags.join(' ') : _flags) : await vscode.window.showInputBox({
        value: '--dev --ws-external',
        prompt: 'Flags to run Substrate with',
        ignoreFocusOut: true
      });
      if (!flags) return; // user cancelled

      // todo use ws port to use polkadot apps
      // does it make sense to have two different polkadot apps endpoints ? two processes, one polkadot app endpoint ?

      if (options.compile) {
        term.sendText(`cargo run --release -- ${flags}`);
      } else {
        term.sendText(path.join(getWorkspaceRoot(defNodePath),`target/release/${getCargoName(defNodePath)}`) + ' ' + flags);
      }
      term.show();

      processes.new({nodePath: defNodePath, command: flags, term: term});
    } catch (e) {
      vscode.window.showErrorMessage(e);
      console.error(e);
    }
    });

    vscode.commands.registerCommand("substrate.compileStartNode", async (nodePathLike?: string | NodeTreeItem, _flags?: string | string[]) => {
      vscode.commands.executeCommand("substrate.startNode", nodePathLike, _flags, {compile: true});
    });

    vscode.commands.registerCommand("substrate.purgeChain", async (nodePathLike?: string | NodeTreeItem) => {
      let nodePath = nodePathLike instanceof NodeTreeItem ? nodePathLike.nodePath : nodePathLike;
      if (nodePath) {
        selectedNodePath$.next(nodePath); // select the item we launch the command on
      }
      const defoNodePath = nodePath || await quickPickNodePath(nodes);
      const term = vscode.window.createTerminal({ name: 'Purge chain', cwd: defoNodePath });

      term.sendText(path.join(getWorkspaceRoot(defoNodePath), `target/release/${getCargoName(defoNodePath)}`) + ' purge-chain --dev'); // TODO s
      term.show();
    });

    const selectedNodePath$ = new BehaviorSubject<string | null>(null); // TODO NULL ON UNSELECT
    const selectedNode$ = new BehaviorSubject<Node | null>(null);

    combineLatest(selectedNodePath$, nodes.nodes$)
      .pipe(
      switchMap(([nodePath, nodes]: [string | null, Node[]]) => {
        if (!nodePath) return of(null);
        const selectedNode = nodes.find(node => node.nodePath === nodePath);
        if (selectedNode === undefined) {
          console.error("Selected node but doesn't match any.");
          return of(null);
        }
        return of(selectedNode);
      }),
      // tap(r => console.log('Selected node \'changes\' fired with', r))
    ).subscribe(selectedNode$);

    const treeDataProvider = new NodesProvider(nodes, selectedNode$);
    vscode.window.createTreeView('substrateNodes', { treeDataProvider });
    vscode.commands.registerCommand("substrateNodes.selectNode", (item: vscode.TreeItem) => {
      selectedNodePath$.next((item as any).nodePath || null);
    });

  return { selectedNode$ };
}
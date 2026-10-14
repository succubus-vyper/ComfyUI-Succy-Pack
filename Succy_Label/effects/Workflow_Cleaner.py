import os
import json
import glob
from collections import deque

def reorder_comfyui_workflow(filepath):
    print(f"[*] Analizzando il file: {filepath}")
    with open(filepath, 'r', encoding='utf-8') as f:
        try:
            workflow = json.load(f)
        except json.JSONDecodeError:
            print(f"[!] Errore: Il file non e' un JSON valido.")
            return

    if "nodes" not in workflow or "links" not in workflow:
        print("[!] Errore: Il file non sembra essere un workflow standard di ComfyUI.")
        print("    Assicurati di averlo salvato usando il tasto 'Save' (non 'Save API').")
        return

    nodes = workflow["nodes"]
    links = workflow["links"]

    # 1. Build the graph from the connections (links)
    dependents = {n["id"]: set() for n in nodes}
    in_degree = {n["id"]: 0 for n in nodes}

    for link in links:
        if not link: continue
        # [link_id, from_node_id, from_slot, to_node_id, to_slot, type]
        _, from_id, _, to_id, _, _ = link
        if from_id in dependents and to_id in in_degree:
            dependents[from_id].add(to_id)
            in_degree[to_id] += 1

    # 2. Kahn's Algorithm for the topological sort
    queue = deque([n["id"] for n in nodes if in_degree[n["id"]] == 0])
    execution_order = []

    while queue:
        current = queue.popleft()
        execution_order.append(current)
        for dependent in dependents.get(current, []):
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                queue.append(dependent)

    # Handle any orphan or disconnected nodes
    missing = set([n["id"] for n in nodes]) - set(execution_order)
    execution_order.extend(list(missing))

    # 3. Build the old ID -> new ID map (from 1 upwards)
    id_map = {old_id: new_id for new_id, old_id in enumerate(execution_order, start=1)}

    # 4. Update the IDs in the nodes
    for node in nodes:
        node["id"] = id_map[node["id"]]

    # 5. Update the IDs in the links
    for link in links:
        if not link: continue
        link[1] = id_map.get(link[1], link[1]) # origin_id
        link[3] = id_map.get(link[3], link[3]) # target_id

    # Optional: reorder the node list in the JSON for visual comfort
    workflow["nodes"].sort(key=lambda x: x["id"])

    # 6. Update last_node_id to prevent future conflicts
    workflow["last_node_id"] = len(nodes)

    # Save the new file
    new_filepath = filepath.replace(".json", "_riordinato.json")
    with open(new_filepath, 'w', encoding='utf-8') as f:
        json.dump(workflow, f, indent=2)

    print(f"[+] Successo! File salvato come: {os.path.basename(new_filepath)}")
    print(f"[+] Riassegnati ID per {len(nodes)} nodi nel workflow.")

def main():
    print("========================================")
    print("   ComfyUI Workflow ID Reorder Tool")
    print("========================================\n")

    # Look for json files, skipping already converted ones to avoid conflicts
    json_files = [f for f in glob.glob("*.json") if not f.endswith("_riordinato.json")]

    if len(json_files) == 0:
        print("[-] Nessun file .json trovato nella cartella corrente.")
    elif len(json_files) > 1:
        print("[-] Trovati troppi file .json nella cartella corrente:")
        for jf in json_files:
            print(f"    - {jf}")
        print("\n[!] Per favore, lascia un solo file .json (il workflow da convertire).")
    else:
        filepath = json_files[0]
        reorder_comfyui_workflow(filepath)

    print("\n")
    input("Premi INVIO per chiudere questa finestra...")

if __name__ == "__main__":
    main()

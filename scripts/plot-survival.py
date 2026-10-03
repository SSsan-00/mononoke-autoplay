"""Matplotlib graphs for aggregate.json (simulator and browser stay separate)."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

directory = Path(sys.argv[1])
data = json.loads((directory / "aggregate.json").read_text())
methods = list(data["methods"])
colors = ["#547a91" if m == "random" else "#da8843" for m in methods]
fig, axes = plt.subplots(2, 3, figsize=(13, 7.5), layout="constrained")

def bars(ax, title, values, label):
    valid = [(m, v, c) for m, v, c in zip(methods, values, colors) if v is not None]
    ax.set_title(title, fontsize=11)
    ax.set_ylabel(label)
    ax.spines[["top", "right"]].set_visible(False)
    if valid:
        labels, heights, palette = zip(*valid)
        ax.bar(labels, heights, color=palette, width=0.55)
        ax.set_ylim(bottom=0)
    else:
        ax.text(.5, .5, "No completed observations", ha="center", va="center", transform=ax.transAxes)

rows = [data["methods"][m] for m in methods]
bars(axes[0, 0], "Observed survival (capped at time limit)", [r["survivalSeconds"]["mean"] for r in rows], "Mean seconds")
bars(axes[0, 1], "Clear rate among normal completions", [None if r["clearRate"] is None else r["clearRate"] * 100 for r in rows], "%")
bars(axes[0, 2], "Browser wall time (normal completions)", [None if r["realElapsedMs"]["mean"] is None else r["realElapsedMs"]["mean"] / 1000 for r in rows], "Mean seconds")
bars(axes[1, 0], "Jev selection opportunities", [None if r["candidateShares"]["multiple"] is None else r["candidateShares"]["multiple"] * 100 for r in rows], "% decisions with >1 candidates")
bars(axes[1, 1], "API attempts (including failed calls)", [r["calls"] for r in rows], "Calls")
ax = axes[1, 2]
delta = data["paired"]["survivalSeconds"]
ax.set_title("Paired survival difference; seed bootstrap", fontsize=11)
ax.axvline(0, color="#999999", linestyle="--", linewidth=1)
if delta["mean"] is not None:
    if delta["ci95"] is not None:
        lo, hi = delta["ci95"]
        ax.plot([lo, hi], [0, 0], color="#da8843", linewidth=3)
    ax.plot(delta["mean"], 0, "o", color="#da8843")
    ax.set_yticks([0], [f"{delta['seedCount']} seeds" if delta["ci95"] is not None else "1 seed; CI unavailable"])
else:
    ax.text(.5, .5, "No complete pairs", transform=ax.transAxes, ha="center")
ax.set_xlabel("Jev / mock-Jev minus random (seconds)")
ax.spines[["top", "right"]].set_visible(False)
kind = "LIVE Jev" if data["manifest"]["live"] else "MOCK API: functional verification only"
fig.suptitle(f"Survival-candidate comparison | {data['manifest']['mode']} | {kind}", fontsize=14)
fig.savefig(directory / "comparison.svg")
fig.savefig(directory / "comparison.png", dpi=160)
plt.close(fig)

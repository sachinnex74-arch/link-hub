import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getLiveFleet, type LiveVehicle } from "@/lib/gps.functions";

export const Route = createFileRoute("/gps")({
  // Client-only: live fleet data is fetched in the browser.
  ssr: false,
  component: GpsPage,
  head: () => ({
    meta: [
      { title: "Live GPS Tracking | Fleet" },
      { name: "description", content: "Real-time vehicle locations and status from Fleetx." },
    ],
  }),
});

const statusColor: Record<string, string> = {
  RUNNING: "bg-green-100 text-green-800",
  PARKED: "bg-yellow-100 text-yellow-800",
  IDLE: "bg-blue-100 text-blue-800",
  REMOVED: "bg-gray-200 text-gray-700",
  DISCONNECTED: "bg-red-100 text-red-800",
  UNREACHABLE: "bg-orange-100 text-orange-800",
};

function parseCsv(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const first = lines[0].toLowerCase();
  const hasHeader = /vehicle|number|reg|plate/.test(first);
  const rows = hasHeader ? lines.slice(1) : lines;
  const nums = new Set<string>();
  for (const row of rows) {
    const cols = row.split(/[,;\t]/).map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols[0]) nums.add(cols[0].toUpperCase());
  }
  return Array.from(nums);
}

function GpsPage() {
  const fetchLive = useServerFn(getLiveFleet);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["fleetx-live"],
    queryFn: () => fetchLive(),
    refetchInterval: 30_000,
  });
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [imported, setImported] = useState<string[]>([]);
  const [onlyImported, setOnlyImported] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const nums = parseCsv(text);
      if (nums.length === 0) {
        setImportMsg("No vehicle numbers found in file.");
        return;
      }
      setImported(nums);
      setOnlyImported(true);
      setImportMsg(`Imported ${nums.length} vehicle${nums.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setImportMsg(`Import failed: ${(e as Error).message}`);
    }
  };

  const importedSet = useMemo(
    () => new Set(imported.map((s) => s.toUpperCase())),
    [imported],
  );

  const filtered = useMemo(() => {
    const vs: LiveVehicle[] = data?.vehicles ?? [];
    return vs.filter((v) => {
      if (onlyImported && !importedSet.has(v.vehicleNumber.toUpperCase())) return false;
      if (statusFilter !== "ALL" && v.currentStatus !== statusFilter) return false;
      if (q && !`${v.vehicleNumber} ${v.vehicleName} ${v.driverName}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [data, q, statusFilter, onlyImported, importedSet]);

  const missingImports = useMemo(() => {
    if (!data || imported.length === 0) return [] as string[];
    const have = new Set(data.vehicles.map((v) => v.vehicleNumber.toUpperCase()));
    return imported.filter((n) => !have.has(n));
  }, [data, imported]);

  const sampleCsv = "vehicleNumber\nHR55AB8222AIS\nHR55AR5033\nHR55AR4409";
  const sampleCsvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(sampleCsv)}`;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Live GPS Tracking</h1>
            <p className="text-sm text-gray-500">Powered by Fleetx · auto-refresh 30s</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={sampleCsvHref}
              download="fleet-sample.csv"
              className="px-3 py-2 text-sm text-blue-600 hover:underline"
            >
              Sample CSV
            </a>
            <label className="px-4 py-2 bg-white border border-gray-300 rounded hover:bg-gray-50 text-sm cursor-pointer">
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImport(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {importMsg && (
          <div className="mb-4 p-3 rounded bg-blue-50 border border-blue-200 text-blue-800 text-sm flex justify-between items-center">
            <span>
              {importMsg}
              {imported.length > 0 && data && (
                <> Matched {imported.length - missingImports.length}/{imported.length} in live fleet.</>
              )}
            </span>
            <button
              onClick={() => {
                setImported([]);
                setOnlyImported(false);
                setImportMsg(null);
              }}
              className="text-xs underline"
            >
              Clear
            </button>
          </div>
        )}
        {missingImports.length > 0 && (
          <div className="mb-4 p-3 rounded bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs">
            Not found in live data ({missingImports.length}): {missingImports.slice(0, 10).join(", ")}
            {missingImports.length > 10 && "…"}
          </div>
        )}
        {isLoading && <div className="text-gray-500">Loading fleet…</div>}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded">
            {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
              <Stat label="Total" value={data.totalVehicles} />
              <Stat label="Running" value={data.runningVehicles} tone="text-green-600" />
              <Stat label="Idle" value={data.idleVehicles} tone="text-blue-600" />
              <Stat label="Parked" value={data.parkedVehicles} tone="text-yellow-600" />
              <Stat label="Disconnected" value={data.disconnectedVehicles} tone="text-red-600" />
              <Stat label="Unreachable" value={data.unreachableVehicles} tone="text-orange-600" />
              <Stat label="Utilization" value={`${data.utilization}%`} />
            </div>

            <div className="flex flex-wrap gap-3 mb-4">
              <input
                placeholder="Search vehicle / driver…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="flex-1 min-w-[200px] px-3 py-2 border rounded text-sm"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 border rounded text-sm"
              >
                {["ALL", "RUNNING", "IDLE", "PARKED", "DISCONNECTED", "UNREACHABLE", "REMOVED"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {imported.length > 0 && (
                <label className="flex items-center gap-2 text-sm px-3 py-2 bg-white border rounded">
                  <input
                    type="checkbox"
                    checked={onlyImported}
                    onChange={(e) => setOnlyImported(e.target.checked)}
                  />
                  Only imported ({imported.length})
                </label>
              )}
            </div>

            <div className="bg-white rounded shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100 text-left text-xs uppercase text-gray-600">
                    <tr>
                      <th className="px-4 py-2">Vehicle</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Speed</th>
                      <th className="px-4 py-2">Driver</th>
                      <th className="px-4 py-2">Location</th>
                      <th className="px-4 py-2">Last Update</th>
                      <th className="px-4 py-2">Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v) => (
                      <tr key={v.vehicleId} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono">{v.vehicleNumber}</td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-1 rounded text-xs ${statusColor[v.currentStatus] ?? "bg-gray-100"}`}>
                            {v.currentStatus}
                          </span>
                        </td>
                        <td className="px-4 py-2">{v.speed.toFixed(0)} km/h</td>
                        <td className="px-4 py-2">{v.driverName || "—"}</td>
                        <td className="px-4 py-2 max-w-xs truncate" title={v.address}>{v.address}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">
                          {new Date(v.lastUpdatedAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-2">
                          <a
                            className="text-blue-600 hover:underline"
                            target="_blank"
                            rel="noreferrer"
                            href={`https://www.google.com/maps?q=${v.latitude},${v.longitude}`}
                          >
                            View
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filtered.length === 0 && (
                <div className="p-6 text-center text-gray-500">No vehicles match.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="bg-white rounded shadow p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

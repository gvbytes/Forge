import net from "net";

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, "127.0.0.1");
  });
}

async function main() {
  const preferred = parseInt(process.argv[2] || "0", 10);
  if (preferred > 0 && (await isFree(preferred))) {
    console.log(preferred);
  } else {
    const freePort = await getFreePort();
    console.log(freePort);
  }
}

main().catch(() => {
  const preferred = parseInt(process.argv[2] || "0", 10);
  console.log(preferred || 4100);
});

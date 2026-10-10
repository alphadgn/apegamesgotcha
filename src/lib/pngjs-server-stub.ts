// Server-only stub for pngjs. Privy's QR module eagerly loads qrcode's server
// entry, and pngjs's top-level util.inherits(...) crashes the deployed worker
// runtime. QR rendering never runs on the server, so an empty PNG class is enough.
export class PNG {}
export const PNGSync = {
  read: () => {
    throw new Error("pngjs is not available on the server");
  },
};
export default { PNG };

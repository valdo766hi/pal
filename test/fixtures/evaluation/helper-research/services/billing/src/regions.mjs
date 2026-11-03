// Each region moves the listener to its own port; unknown regions keep the defaults.
export const regions = {
  us: { port: 9100 },
  eu: { port: 9443, host: "0.0.0.0" },
};

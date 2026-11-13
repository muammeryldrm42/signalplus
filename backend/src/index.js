const app = require("./app");

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SignalPlus V8 running on http://localhost:${PORT}`));

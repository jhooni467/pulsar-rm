
/* PULSAR RM — APPLICATION CORE */

const PulsarRM = {
    name: "Pulsar RM",
    version: "0.1.0",

    init() {
        console.log("Pulsar RM iniciado correctamente.");
        console.log("Welcome to your music universe.");
    }
};

document.addEventListener("DOMContentLoaded", () => {
    PulsarRM.init();
});

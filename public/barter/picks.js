(function () {
  const node = document.getElementById("picks");
  if (!node) return;
  fetch("/lookup.json?t=" + Date.now())
    .then((response) => {
      if (!response.ok) throw new Error("missing");
      return response.json();
    })
    .then((book) => {
      node.textContent = book.send === true
        ? "Picks live · Payouts open"
        : "Picks live · KORE not open yet";
    })
    .catch(() => {
      node.textContent = "Picks live";
    });
})();

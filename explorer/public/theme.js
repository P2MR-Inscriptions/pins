// SPDX-License-Identifier: Apache-2.0

try {
  var saved = localStorage.getItem("pins-theme");
  var dark = saved !== "light";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#110e0c" : "#f3f1ec");
} catch (e) { /* storage unavailable */ }

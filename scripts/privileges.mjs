export const REQUIRED_PRIVILEGES = [
  "http://tizen.org/privilege/internet",
  "http://developer.samsung.com/privilege/network.public",
  "http://tizen.org/privilege/tv.inputdevice",
  "http://tizen.org/privilege/filesystem.read",
  "http://tizen.org/privilege/filesystem.write",
  "http://tizen.org/privilege/application.launch",
  "http://developer.samsung.com/privilege/productinfo",
];

export function missingPrivileges(xml) {
  return REQUIRED_PRIVILEGES.filter((name) => !xml.includes(`name="${name}"`));
}

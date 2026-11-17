// A time zone by its IANA name, as THE MONITOR takes one (minutes east of UTC at a time): for tests of days and
// printed times that must come out the same whatever zone the machine running them is in.
export function zoneNamed(name: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "longOffset" });
  return (t: number) => {
    const [, sign, hours, minutes] = format.formatToParts(t).find((part) => part.type === "timeZoneName")!.value.match(/([+-])(\d\d):(\d\d)/) ?? [];
    return sign ? (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) : 0;
  };
}

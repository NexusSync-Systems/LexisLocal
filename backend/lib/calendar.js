const { execFile } = require('child_process');

// Texty události (název, popis, místo) mohou pocházet z e-mailu nebo od agenta. Do skriptu se proto
// NEVKLÁDAJÍ — AppleScript je dostane jako argumenty (argv), PowerShell jako proměnné prostředí
// (review 2, skupina 5: vložení kódu přes název události, např. typografickým apostrofem v PowerShellu).
const MAX_TEXT = 4000;
function _txt(v) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, MAX_TEXT); }
const path = require('path');
const fs = require('fs');

/**
 * Helper to format a Date for AppleScript
 * Generates lines to construct an AppleScript date object
 */
function generateAppleScriptDate(dateVarName, dateObj) {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1; // 1-12
    const day = dateObj.getDate();
    const hours = dateObj.getHours();
    const minutes = dateObj.getMinutes();
    const seconds = dateObj.getSeconds();
    
    return `
set ${dateVarName} to (current date)
set day of ${dateVarName} to 1
set year of ${dateVarName} to ${year}
set monthNames to {January, February, March, April, May, June, July, August, September, October, November, December}
set month of ${dateVarName} to item ${month} of monthNames
set day of ${dateVarName} to ${day}
set time of ${dateVarName} to (${hours} * 3600 + ${minutes} * 60 + ${seconds})
    `.trim();
}

/**
 * Sync event to macOS Apple Calendar
 */
function syncMacCalendar({ title, startDate, endDate, description, location }) {
    return new Promise((resolve, reject) => {
        const startScript = generateAppleScriptDate('startDate', startDate);
        const endScript = generateAppleScriptDate('endDate', endDate);

        const appleScript = `
on run argv
set evTitle to item 1 of argv
set evDesc to item 2 of argv
set evLoc to item 3 of argv
${startScript}
${endScript}

tell application "Calendar"
    set calName to "LexisLocal"
    if not (exists calendar calName) then
        create calendar with name calName
    end if
    set targetCal to calendar calName

    set matchedEvents to (events of targetCal whose summary is evTitle)
    set duplicateFound to false
    repeat with ev in matchedEvents
        if (start date of ev) is equal to startDate then
            set duplicateFound to true
            exit repeat
        end if
    end repeat

    if not duplicateFound then
        make new event at end of events of targetCal with properties {summary:evTitle, start date:startDate, end date:endDate, description:evDesc, location:evLoc}
        return "created"
    else
        return "duplicate"
    end if
end tell
end run
        `;

        const proc = execFile('osascript', ['-', _txt(title), _txt(description), _txt(location)], (error, stdout, stderr) => {
            if (error) {
                console.error("❌ AppleScript Error:", stderr);
                return reject(error);
            }
            resolve(String(stdout).trim());
        });

        proc.stdin.write(appleScript);
        proc.stdin.end();
    });
}

/**
 * Sync event to Windows MS Outlook
 */
function syncWinCalendar({ title, startDate, endDate, description, location }) {
    return new Promise((resolve, reject) => {
        // Format dates as local strings that PowerShell / COM can parse
        // e.g. "2026-06-02 14:00:00"
        const formatForPS = (d) => {
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        };
        
        const psStart = formatForPS(startDate);
        const psEnd = formatForPS(endDate);
        // PowerShell čte texty z proměnných prostředí — do skriptu se nevkládají.
        const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNameSpace("MAPI")
$calendar = $namespace.GetDefaultFolder(9) # olFolderCalendar

$subj = $env:LEXIS_CAL_TITLE
$start = [DateTime]::Parse('${psStart}')
$end = [DateTime]::Parse('${psEnd}')

# Query events matching Subject and Start time (apostrof ve filtru zdvojit)
$filter = "[Subject] = '" + ($subj -replace "'", "''") + "'"
$items = $calendar.Items.Restrict($filter)
$duplicate = $false

foreach ($item in $items) {
    if ($item.Start -eq $start) {
        $duplicate = $true
        break
    }
}

if (-not $duplicate) {
    $event = $outlook.CreateItem(1) # olAppointmentItem
    $event.Subject = $subj
    $event.Start = $start
    $event.End = $end
    $event.Body = $env:LEXIS_CAL_DESC
    $event.Location = $env:LEXIS_CAL_LOC
    $event.Save()
    Write-Output "created"
} else {
    Write-Output "duplicate"
}
        `;

        const env = Object.assign({}, process.env, { LEXIS_CAL_TITLE: _txt(title), LEXIS_CAL_DESC: _txt(description), LEXIS_CAL_LOC: _txt(location) });
        const proc = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { env }, (error, stdout, stderr) => {
            if (error) {
                console.error("❌ PowerShell Error:", stderr);
                return reject(error);
            }
            resolve(String(stdout).trim());
        });

        proc.stdin.write(psScript);
        proc.stdin.end();
    });
}

/**
 * Core entry point for writing events to the system calendar
 * Supports Apple Calendar on macOS (darwin) and Outlook on Windows (win32)
 */
async function writeToSystemCalendar({ title, date, time, location, description }) {
    const platform = process.platform;
    
    // Parse Dates
    let startDate, endDate;
    if (!date) {
        throw new Error("Date is required.");
    }
    
    if (time) {
        const [h, m] = time.split(':');
        startDate = new Date(`${date}T${h}:${m}:00`);
        // Default appointment duration is 1 hour
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    } else {
        // All-day event
        startDate = new Date(`${date}T09:00:00`);
        endDate = new Date(`${date}T10:00:00`);
    }
    
    console.log(`📅 Pokus o zápis do systémového kalendáře (${platform}): "${title}" dne ${date} v ${time || 'celý den'}`);
    
    if (platform === 'darwin') {
        return await syncMacCalendar({ title, startDate, endDate, description, location });
    } else if (platform === 'win32') {
        return await syncWinCalendar({ title, startDate, endDate, description, location });
    } else {
        console.warn(`⚠️ Platforma ${platform} nepodporuje přímý zápis do nativního kalendáře.`);
        return 'unsupported_platform';
    }
}

module.exports = {
    writeToSystemCalendar
};

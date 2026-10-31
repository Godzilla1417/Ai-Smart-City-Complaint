const departments = {
  Roads: 'Public Works',
  Sanitation: 'Environmental Services',
  Streetlights: 'Street Services',
  Water: 'Water Utilities',
  'Public spaces': 'Parks & Recreation',
  Other: 'City Services'
};

function evaluatePriority({ title = '', description = '', category = 'Other', location = '', hasPhoto = false } = {}) {
  const text = `${title} ${description}`.toLowerCase();
  let level = 'MEDIUM';
  let confidence = 'Low';
  let reason = 'A timely response is appropriate based on the reported issue category; the description does not establish an immediate safety risk.';
  const critical = [
    [/\b(exposed (wire|electrical wire|live wire)|live electrical|electrocution|power line down)\b/, 'The report mentions exposed or live electrical equipment.'],
    [/\b(open|uncovered|missing cover on) (manhole|sewer hole)\b/, 'The report mentions an uncovered manhole, which can be an immediate safety hazard.'],
    [/\b(gas leak|gas smell|structural collapse|building collapse|sinkhole)\b/, 'The report mentions a potentially immediate public-safety hazard.'],
    [/\b(major|burst|broken) (water )?(pipeline|water main)\b/, 'The report describes major pipeline damage.'],
    [/\b(traffic signal|traffic light).{0,35}\b(not working|out|failed|broken)\b.{0,50}\b(busy|major|intersection|crossroad)\b/, 'The report describes a failed traffic signal at a busy intersection.'],
    [/\b(immediate danger|life[- ]threatening|serious injury|people injured)\b/, 'The report explicitly describes immediate danger or injury.'],
    [/\b(road|bridge).{0,35}\b(collapse|washed away|large sinkhole|impassable)\b/, 'The report describes severe road or bridge damage.']
  ];
  const high = [
    [/\b(major|large|severe|overflowing|piles of) (garbage|trash|waste|rubbish)\b/, 'The report describes major garbage accumulation.'],
    [/\b(significant|heavy|major|continuous) (water )?leak(age)?\b/, 'The report describes a significant or continuous water leak.'],
    [/\b(severe|major|blocked|overflowing) drain(age)?\b/, 'The report describes a severe drainage blockage or overflow.'],
    [/\b(multiple|many|entire block|whole street|several homes|many households)\b/, 'The report indicates that multiple homes or a wider area may be affected.'],
    [/\b(pothole|road hazard|road damage).{0,40}\b(large|deep|dangerous|severe|accident|crash)\b/, 'The report describes a potentially dangerous road hazard.']
  ];
  const low = [[/\b(minor|small|routine|cosmetic|non[- ]urgent)\b/, 'The report describes the issue as minor or routine.']];
  const find = patterns => patterns.find(([pattern]) => pattern.test(text));
  let match = find(critical);
  if (match) { level = 'CRITICAL'; confidence = 'High'; reason = match[1]; }
  else if ((match = find(high))) { level = 'HIGH'; confidence = 'Medium'; reason = match[1]; }
  else if ((match = find(low))) { level = 'LOW'; confidence = 'Medium'; reason = match[1]; }
  else if (/\b(broken|damaged|not working|blocked|leaking|pothole|streetlight|footpath)\b/.test(text)) {
    level = 'MEDIUM'; confidence = 'Medium'; reason = 'The description reports a service or infrastructure fault that needs timely attention.';
  } else if (text.trim().length > 0) {
    reason = 'No explicit safety risk or wider impact was identified in the text; staff should review the report and adjust if needed.';
  }
  const affected = text.match(/\b(\d{1,6})\s+(households?|homes|residents|people|families)\b/);
  if (affected && Number(affected[1]) >= 10 && level !== 'CRITICAL') {
    level = 'HIGH'; confidence = 'Medium';
    reason = `The report says approximately ${affected[1]} ${affected[2]} may be affected.`;
  }
  const hasSpecificContext = /\b(school|hospital|clinic|busy intersection|crossroad|market|transit station)\b/.test(`${text} ${location.toLowerCase()}`);
  if (hasSpecificContext && level === 'MEDIUM' && /\b(safety|danger|hazard|traffic|crossing)\b/.test(text)) {
    level = 'HIGH'; confidence = 'Low';
    reason = 'A safety concern and a sensitive location are mentioned; staff should confirm the location context.';
  }
  if (hasPhoto && confidence === 'High') confidence = 'Medium';
  const responseTime = ({ CRITICAL: 'Immediate review', HIGH: 'Within 24 hours', MEDIUM: 'Within 3 business days', LOW: 'Routine scheduling' })[level];
  return {
    priorityLevel: level,
    priorityReason: hasPhoto ? `${reason} A photo is attached, but this triage did not interpret image contents.` : reason,
    priorityConfidence: confidence,
    priorityDepartment: departments[category] || 'City Services',
    priorityResponseTime: responseTime
  };
}

module.exports = { evaluatePriority, departments };

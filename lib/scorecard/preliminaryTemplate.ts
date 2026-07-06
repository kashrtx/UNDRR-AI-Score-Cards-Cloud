/**
 * Canonical UNDRR ARISE Preliminary scorecard template: the 47 indicators,
 * grouped under the Ten Essentials, each scored 0-3. Extracted from the official
 * 2024 Preliminary workbook so the assistant knows every question even when the
 * user starts from a completely blank slate.
 */

export interface TemplateIndicator { code: string; essential: number; text: string; }

export const ESSENTIAL_NAMES: Record<number, string> = {
  1: "Organize for Resilience",
  2: "Identify & Understand Risk Scenarios",
  3: "Strengthen Financial Capacity",
  4: "Pursue Resilient Urban Development",
  5: "Safeguard Natural Buffers",
  6: "Strengthen Institutional Capacity",
  7: "Strengthen Societal Capacity",
  8: "Increase Infrastructure Resilience",
  9: "Ensure Effective Disaster Response",
  10: "Expedite Recovery & Build Back Better",
};

export const PRELIMINARY_INDICATORS: TemplateIndicator[] = [
  { code: "P1.1", essential: 1, text: "Does the City master plan (or relevant strategy/plan) adopt the Sendai Framework?" },
  { code: "P1.2", essential: 1, text: "Is there a multi-agency/sectoral mechanism with appropriate authority and resources to address disaster risk reduction?" },
  { code: "P1.3", essential: 1, text: "Is resilience properly integrated with other key city functions / portfolios?" },
  { code: "P2.1", essential: 2, text: "Does the city have knowledge of the key hazards that the city faces, and their likelihood of occurrence?" },
  { code: "P2.2", essential: 2, text: "Is there a shared understanding of risks between the city and various utility providers and other regional and national agencies that have a role in managing infrastructure such as power, water, roads and trains, of the points of stress on the system and city scale risks?" },
  { code: "P2.3", essential: 2, text: "Are their agreed scenarios setting out city-wide exposure and vulnerability from each hazard, or groups of hazards (see above)?" },
  { code: "P2.4", essential: 2, text: "Is there a collective understanding of potentially cascading failures between different city and infrastructure systems, under different scenarios?" },
  { code: "P2.5", essential: 2, text: "Do clear hazard maps and data on risk exist? Are these regularly updated?" },
  { code: "P3.1", essential: 3, text: "The city / lead agencies understand all sources of funding, and the “resilience dividends”, are well connected, understand all available routes to attract external funding and are actively pursuing funds for major resilience investments." },
  { code: "P3.2", essential: 3, text: "Does the city have in place a specific ‘ring fenced’ (protected) budget, the necessary resources and contingency fund arrangements for local disaster risk reduction (mitigation, prevention, response and recovery)?" },
  { code: "P3.3", essential: 3, text: "What level of insurance cover exists in the city, across all sectors – business and community?" },
  { code: "P3.4", essential: 3, text: "What incentives exist for different sectors and segments of business and society to support resilience building?" },
  { code: "P4.1", essential: 4, text: "Is the city appropriately zoned considering, for example, the impact from key risk scenarios on economic activity, agricultural production, and population centres?" },
  { code: "P4.2", essential: 4, text: "Are approaches promoted through the design and development of new urban development to promote resilience?" },
  { code: "P4.3", essential: 4, text: "Do building codes or standards exist, and do they address specific known hazards and risks for the city? Are these standards regularly updated?" },
  { code: "P4.4", essential: 4, text: "Are zoning rules, building codes and standards widely applied, properly enforced and verified?" },
  { code: "P5.1", essential: 5, text: "Beyond just an awareness of the natural assets, does the city understand the functions (or services) that this natural capital provides for the city?" },
  { code: "P5.2", essential: 5, text: "Is green and blue infrastructure being promoted on major urban development and infrastructure projects through policy?" },
  { code: "P5.3", essential: 5, text: "Is the city aware of ecosystem services being provided to the city from natural capital beyond its administrative borders? Are agreements in place with neighbouring administrations to support the protection and management of these assets?" },
  { code: "P6.1", essential: 6, text: "Does the city have clear access to all the skills and experience it believes it would need to respond to reduce risks and respond to identified disaster scenarios?" },
  { code: "P6.2", essential: 6, text: "Does a co-ordinated public relations and education campaign exist, with structured messaging and channels to ensure hazard, risk and disaster information (that can be understood and used) are properly disseminated to the public?" },
  { code: "P6.3", essential: 6, text: "Extent to which data on the city’s resilience context is shared with other organizations involved with the city’s resilience." },
  { code: "P6.4", essential: 6, text: "Are there training courses covering risk and resilience issues offered to all sectors of the city including government, business, NGOs and community?" },
  { code: "P6.5", essential: 6, text: "Are training materials available in the majority of languages in common use in the city?" },
  { code: "P6.6", essential: 6, text: "Is the city proactively seeking to exchange knowledge and learn from other cities facing similar challenges?" },
  { code: "P7.1", essential: 7, text: "Are “grassroots” or community organizations participating in risk reduction and post-event response for each neighbourhood in the city?" },
  { code: "P7.2", essential: 7, text: "Are there regular training programmes provided to the most vulnerable populations in the city?" },
  { code: "P7.3", essential: 7, text: "What proportion of businesses have a documented business continuity plan that has been reviewed within the last 18 months?" },
  { code: "P7.4", essential: 7, text: "How effective is the city at citizen engagement and communications in relation to DRR?" },
  { code: "P8.1", essential: 8, text: "Is critical infrastructure resilience a city priority, does the city own and implement a critical infrastructure plan or strategy?" },
  { code: "P8.2", essential: 8, text: "Is existing protective infrastructure well-designed and well-built based on risk information?" },
  { code: "P8.3", essential: 8, text: "Would a significant loss of service for these two essential services be expected for a significant proportion of the city under the agreed disaster scenarios?" },
  { code: "P8.4", essential: 8, text: "Would a significant loss of service be expected for a significant proportion of the city in the ‘worst case’ scenario event? In the event of failure would energy infrastructure corridors remain safe (i.e. free from risk of leaks, electrocution hazards etc.)?" },
  { code: "P8.5", essential: 8, text: "Would a significant loss of service be expected for a significant proportion of the city in the ‘worst case’ scenario event? In the event of failure would transport infrastructure corridors remain safe (i.e. free from risk of flood, shocks etc) and passable?" },
  { code: "P8.6", essential: 8, text: "Would a significant loss of service be expected for a significant proportion of the city in the ‘worst case’ scenario event?" },
  { code: "P8.7", essential: 8, text: "Would there be sufficient acute healthcare capabilities to deal with expected major injuries in ‘worst case’ scenario?" },
  { code: "P8.8", essential: 8, text: "% of education structures at risk of damage from “most probable” and “most severe” scenarios" },
  { code: "P8.9", essential: 8, text: "Will there be sufficient first responder equipment, with military or civilian back up as required?" },
  { code: "P9.1", essential: 9, text: "Does the city have a plan or standard operating procedure to act on early warnings and forecasts? What proportion of the population is reachable by early warning system?" },
  { code: "P9.2", essential: 9, text: "Is there a disaster management / preparedness / emergency response plan outlining city mitigation, preparedness and response to local emergencies?" },
  { code: "P9.3", essential: 9, text: "Does the responsible disaster management authority have sufficient staffing capacity to support first responder duties in surge event scenario?" },
  { code: "P9.4", essential: 9, text: "Are equipment and supply needs, as well as the availability of equipment, clearly defined?" },
  { code: "P9.5", essential: 9, text: "Would the city be able to continue to feed and shelter its population post-event?" },
  { code: "P9.6", essential: 9, text: "Is there an emergency operations centre, with participation from all agencies, automating standard operating procedures specifically designed to deal with “most probable” and “most severe” scenarios?" },
  { code: "P9.7", essential: 9, text: "Do practices and drills involve both the public and professionals?" },
  { code: "P10.1", essential: 10, text: "Is there a strategy or process in place for post-event recovery and reconstruction, including economic reboot, societal aspects etc.?" },
  { code: "P10.2", essential: 10, text: "Do post-event assessment processes incorporate failure analyses and the ability to capture lessons learned that then feed into design and delivery of rebuilding projects?" },
];

export const TOTAL_INDICATORS = PRELIMINARY_INDICATORS.length; // 47
export const TOTAL_MAX = TOTAL_INDICATORS * 3; // 141

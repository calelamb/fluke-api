import { PrismaClient } from '@prisma/client';
import type { NotableEvent, SourceCitation } from '@fluke/shared';

// Whale bios are written from public sources and represent the project author's
// understanding as of seed time. Authoritative catalogs are maintained by:
//   - Center for Whale Research (Southern Residents): https://www.whaleresearch.com/
//   - Bigg's Killer Whale ID Project (Transients): https://www.bcwhales.org/
//   - Orca Network (sightings & history): https://www.orcanetwork.org/
// For any individual, defer to those sources over this seed data.

const prisma = new PrismaClient();

const CITE_CWR: SourceCitation = {
  label: 'Center for Whale Research',
  url: 'https://www.whaleresearch.com/',
};
const CITE_ORCA_NETWORK: SourceCitation = {
  label: 'Orca Network',
  url: 'https://www.orcanetwork.org/',
};
const CITE_BAY_CETOLOGY: SourceCitation = {
  label: 'Bay Cetology / Bigg’s Killer Whale ID Project',
  url: 'https://www.bcwhales.org/',
};
const CITE_NOAA_SRKW: SourceCitation = {
  label: 'NOAA Fisheries — Southern Resident Killer Whale recovery',
  url: 'https://www.fisheries.noaa.gov/west-coast/endangered-species-conservation/southern-resident-killer-whales-recovery-program',
};

type WhaleSeed = {
  catalogId: string;
  name: string | null;
  ecotype: 'RESIDENT' | 'BIGGS' | 'OFFSHORE' | 'UNKNOWN';
  pod: string | null;
  sex: 'MALE' | 'FEMALE' | 'UNKNOWN';
  birthYear: number | null;
  deathYear?: number | null;
  status: 'ALIVE' | 'DECEASED' | 'UNKNOWN';
  biography: string;
  distinguishingMarks?: string;
  notableEvents?: NotableEvent[];
  sourceCitations?: SourceCitation[];
};

const whales: WhaleSeed[] = [
  {
    catalogId: 'J2',
    name: 'Granny',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'FEMALE',
    birthYear: 1911,
    deathYear: 2016,
    status: 'DECEASED',
    biography:
      "For decades the matriarch of J pod, Granny was popularly considered to be among the oldest known orcas at the time of her death. The original 1911 birth-year estimate has since been disputed — it traced back to a 1987 paper that built on later-revised assumptions about her relationship to J1 (Ruffles), and more recent fatty-acid analysis suggests her actual age at death was likely between her mid-sixties and early eighties. What is not disputed is her significance. Granny was one of the longest-documented Southern Resident killer whales, led her family through the Salish Sea into old age, and became a public symbol of orca longevity and matrilineal social structure.",
    distinguishingMarks:
      'A distinctive half-moon nick midway down the trailing edge of her dorsal fin.',
    notableEvents: [
      {
        year: 1911,
        type: 'birth',
        summary: 'Estimated birth year (contested; original 1987 estimate later disputed).',
      },
      {
        year: 2016,
        type: 'death',
        summary:
          'Last seen in October 2016 with J pod near the west side of San Juan Island; declared deceased by the Center for Whale Research at year-end.',
        source: 'Center for Whale Research',
      },
    ],
    sourceCitations: [CITE_CWR, CITE_ORCA_NETWORK],
  },
  {
    catalogId: 'J35',
    name: 'Tahlequah',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'FEMALE',
    birthYear: 1998,
    status: 'ALIVE',
    biography:
      "Tahlequah is the daughter of Princess Angeline (J17) and one of the most publicly recognised members of the Southern Resident community. Her firstborn, J47 (Notch), arrived in 2010 and remains alive. In 2018 she carried a deceased newborn calf for seventeen days across more than a thousand miles of the Salish Sea — what researchers and naturalists came to call her tour of grief, and what drew international attention to the food-supply crisis facing Southern Residents. She gave birth to J57 (Phoenix), a son, in 2020. In December 2024 she had another calf, J61, who was declared dead on December 31, 2024; Tahlequah was again observed carrying the calf's body, in what has been described as a second tour of grief.",
    distinguishingMarks: 'Slightly curved dorsal fin with a clean trailing edge.',
    notableEvents: [
      {
        year: 1998,
        type: 'birth',
        summary: 'Born to Princess Angeline (J17) of J pod.',
      },
      {
        year: 2010,
        type: 'birth',
        summary: 'First calf, J47 (Notch), born.',
      },
      {
        year: 2018,
        type: 'loss',
        summary:
          'Carried a deceased newborn calf for seventeen days across more than a thousand miles — the first “tour of grief.”',
        source: 'Center for Whale Research',
      },
      {
        year: 2020,
        type: 'birth',
        summary: 'Calf J57 (Phoenix) born.',
      },
      {
        year: 2024,
        date: '2024-12-20',
        type: 'birth',
        summary: 'Calf J61 born in December.',
      },
      {
        year: 2024,
        date: '2024-12-31',
        type: 'loss',
        summary:
          'J61 declared dead. Tahlequah was again observed carrying the calf’s body — a second tour of grief.',
        source: 'Center for Whale Research',
      },
    ],
    sourceCitations: [CITE_CWR, CITE_ORCA_NETWORK, CITE_NOAA_SRKW],
  },
  {
    catalogId: 'J47',
    name: 'Notch',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'MALE',
    birthYear: 2010,
    status: 'ALIVE',
    biography:
      'Tahlequah’s firstborn calf, often called Notch for the distinctive marking on his dorsal fin. Now in his mid-teens, J47 has matured into a young adult male and remains a regular member of J pod sightings.',
    notableEvents: [
      { year: 2010, type: 'birth', summary: 'Born to Tahlequah (J35).' },
    ],
    sourceCitations: [CITE_CWR],
  },
  {
    catalogId: 'J57',
    name: 'Phoenix',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'MALE',
    birthYear: 2020,
    status: 'ALIVE',
    biography:
      'Tahlequah’s third surviving offspring, born in 2020 — two years after she carried a lost newborn through the Salish Sea. Researchers, naturalists, and the public welcomed Phoenix as a small, hopeful counterweight to the loss the world had watched two summers earlier.',
    notableEvents: [
      { year: 2020, type: 'birth', summary: 'Born to Tahlequah (J35).' },
    ],
    sourceCitations: [CITE_CWR],
  },
  {
    catalogId: 'J17',
    name: 'Princess Angeline',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'FEMALE',
    birthYear: 1977,
    deathYear: 2019,
    status: 'DECEASED',
    biography:
      "Mother of Tahlequah (J35) and matriarch of one of J pod’s most prominent matrilines. By late 2018 she was photographed showing peanut-head and other body-condition indicators consistent with severe malnutrition, and she was declared missing in August 2019. No necropsy was performed; her death was reported as consistent with malnutrition linked to declining Chinook salmon, a framing that drew renewed attention to the food-supply crisis facing Southern Residents.",
    distinguishingMarks: 'Tall, straight female dorsal fin.',
    notableEvents: [
      { year: 1977, type: 'birth', summary: 'Born into J pod.' },
      { year: 1998, type: 'birth', summary: 'Daughter J35 (Tahlequah) born.' },
      {
        year: 2019,
        type: 'death',
        summary:
          'Declared missing in August 2019 after months of declining body condition; no necropsy performed.',
        source: 'Center for Whale Research',
      },
    ],
    sourceCitations: [CITE_CWR, CITE_NOAA_SRKW],
  },
  {
    catalogId: 'J16',
    name: 'Slick',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'FEMALE',
    birthYear: 1972,
    status: 'ALIVE',
    biography:
      'One of the older living members of J pod and a respected matriarch within her family group. Slick has been observed in the Salish Sea for over five decades, making her presence a near-constant of summer orca-watching in the San Juan Islands.',
    notableEvents: [{ year: 1972, type: 'birth', summary: 'Estimated birth year.' }],
    sourceCitations: [CITE_CWR],
  },
  {
    catalogId: 'J26',
    name: 'Mike',
    ecotype: 'RESIDENT',
    pod: 'J',
    sex: 'MALE',
    birthYear: 1991,
    status: 'ALIVE',
    biography:
      "A large adult male of J pod, easily identified by his towering dorsal fin — a defining feature of mature male orcas, which can reach over six feet in height. Mike has been documented for decades and is one of the more reliably-sighted males of the Southern Resident community.",
    distinguishingMarks: 'Towering male dorsal fin, characteristic of post-sprouter adult males.',
    notableEvents: [{ year: 1991, type: 'birth', summary: 'Born into J pod.' }],
    sourceCitations: [CITE_CWR],
  },
  {
    catalogId: 'L87',
    name: 'Onyx',
    ecotype: 'RESIDENT',
    pod: 'L',
    sex: 'MALE',
    birthYear: 1992,
    status: 'ALIVE',
    biography:
      "Onyx is unusual among Southern Residents for having moved between pods after the death of his mother. He travelled with K7 (Lummi), then K11 (Georgia), then J8 (Spieden), and most prominently with J2 (Granny) before her disappearance in 2016. After Granny was lost, Onyx returned to spending time with L pod. His behaviour provides researchers a rare window into the flexibility of orca social bonds across pod lines.",
    notableEvents: [
      { year: 1992, type: 'birth', summary: 'Born into L pod.' },
      {
        year: 2010,
        type: 'pod-switch',
        summary:
          'Travelled extensively with J pod, most prominently alongside J2 (Granny), after losing successive maternal-figure whales in K and J pods.',
      },
      {
        year: 2016,
        type: 'pod-switch',
        summary: 'Returned to spending time with L pod following the disappearance of Granny (J2).',
      },
    ],
    sourceCitations: [CITE_CWR],
  },
  {
    catalogId: 'L25',
    name: 'Ocean Sun',
    ecotype: 'RESIDENT',
    pod: 'L',
    sex: 'FEMALE',
    birthYear: 1928,
    status: 'ALIVE',
    biography:
      'Ocean Sun is the oldest living member of the Southern Resident community, with an estimated birth year of approximately 1928. She is widely believed, on acoustic and behavioural evidence, to be the mother of the whale captured at Penn Cove in 1970 who came to be known as Tokitae or Sk’aliCh’elh-tenaut. The relationship is inferred rather than pedigreed; for decades it shaped the case for returning Tokitae to the Salish Sea.',
    notableEvents: [
      { year: 1928, type: 'birth', summary: 'Estimated birth year.' },
      {
        year: 1970,
        type: 'milestone',
        summary:
          'Believed (on acoustic and behavioural evidence) to be the mother of the calf captured at Penn Cove in August 1970.',
      },
    ],
    sourceCitations: [CITE_CWR, CITE_ORCA_NETWORK],
  },
  {
    catalogId: 'TOKI',
    name: 'Tokitae / Sk’aliCh’elh-tenaut',
    ecotype: 'RESIDENT',
    pod: 'L',
    sex: 'FEMALE',
    birthYear: 1966,
    deathYear: 2023,
    status: 'DECEASED',
    biography:
      'Tokitae — also known as Lolita and, to the Lummi Nation, as Sk’aliCh’elh-tenaut — was captured at Penn Cove in August 1970 at approximately four years of age and spent more than five decades in captivity at the Miami Seaquarium. Her capture predated the systematic Southern Resident photo-identification catalogue and she was never assigned a stable canonical L-pod number; the catalog ID used here (TOKI) is a project convention, not a CWR designation. Plans to return her to a sea sanctuary in the Salish Sea were underway when she died in August 2023. Her story became a defining chapter in the international movement to end orca captivity.',
    notableEvents: [
      { year: 1966, type: 'birth', summary: 'Estimated birth year (±2 years).' },
      {
        year: 1970,
        date: '1970-08-08',
        type: 'capture',
        summary: 'Captured at Penn Cove during the largest of the Salish Sea capture events.',
      },
      {
        year: 1970,
        type: 'milestone',
        summary: 'Transported to the Miami Seaquarium, where she remained for more than 53 years.',
      },
      {
        year: 2023,
        type: 'milestone',
        summary:
          'Plans to return her to a sea sanctuary in the Salish Sea were underway, supported by the Lummi Nation under the name Sk’aliCh’elh-tenaut.',
      },
      {
        year: 2023,
        date: '2023-08-18',
        type: 'death',
        summary: 'Died at the Miami Seaquarium in August 2023.',
        source: 'Orca Network',
      },
    ],
    sourceCitations: [CITE_ORCA_NETWORK, CITE_CWR],
  },
  {
    catalogId: 'T065A2',
    name: 'Ooxjaa',
    ecotype: 'BIGGS',
    pod: 'T065A matriline',
    sex: 'MALE',
    birthYear: null,
    status: 'ALIVE',
    biography:
      "A mature member of the T065A matriline, one of the frequently-sighted Bigg’s killer whale family groups in the Salish Sea. Bigg’s orcas — also called transients — hunt marine mammals such as harbor seals, porpoises, and sea lions, and travel in smaller, quieter groups than fish-eating Residents. For definitive identification details, defer to the Bigg’s Killer Whale ID Project.",
    sourceCitations: [CITE_BAY_CETOLOGY],
  },
  {
    catalogId: 'T049A1',
    name: 'Noah',
    ecotype: 'BIGGS',
    pod: 'T049A matriline',
    sex: 'MALE',
    birthYear: 2001,
    status: 'ALIVE',
    biography:
      "A large adult male of the T049A matriline, identifiable to trained observers by his tall dorsal fin and saddle patch pattern. Bigg’s killer whales have shown a population increase in recent decades, in contrast to the declining trend among Southern Residents. For definitive identification details, defer to the Bigg’s Killer Whale ID Project.",
    notableEvents: [{ year: 2001, type: 'birth', summary: 'Estimated birth year.' }],
    sourceCitations: [CITE_BAY_CETOLOGY],
  },
  {
    catalogId: 'T037A1B',
    name: null,
    ecotype: 'BIGGS',
    pod: 'T037A matriline',
    sex: 'UNKNOWN',
    birthYear: null,
    status: 'ALIVE',
    biography:
      "A young member of the T037A matriline (offspring of T037A1, “Inyo”), documented in the past several years travelling with close relatives throughout the Salish Sea. Sub-offspring designators in the Bigg’s catalog are sometimes thinly documented; for definitive identification details, defer to the Bigg’s Killer Whale ID Project.",
    sourceCitations: [CITE_BAY_CETOLOGY],
  },
];

async function main() {
  console.log('Seeding whales...');
  for (const w of whales) {
    const { notableEvents, sourceCitations, ...rest } = w;
    const data = {
      ...rest,
      notableEvents: (notableEvents ?? []) as object,
      sourceCitations: (sourceCitations ?? []) as object,
    };
    await prisma.whale.upsert({
      where: { catalogId: w.catalogId },
      create: data,
      update: data,
    });
    console.log(`  - ${w.catalogId}${w.name ? ` (${w.name})` : ''}`);
  }

  console.log('Setting lineage...');
  const lineage: Array<[string, string]> = [
    ['J35', 'J17'],
    ['J47', 'J35'],
    ['J57', 'J35'],
    ['TOKI', 'L25'],
  ];

  for (const [childCatalogId, motherCatalogId] of lineage) {
    const child = await prisma.whale.findUnique({ where: { catalogId: childCatalogId } });
    const mother = await prisma.whale.findUnique({ where: { catalogId: motherCatalogId } });
    if (child && mother) {
      await prisma.whale.update({
        where: { id: child.id },
        data: { motherId: mother.id },
      });
      console.log(`  - ${childCatalogId} -> mother ${motherCatalogId}`);
    }
  }

  console.log(`\nSeeded ${whales.length} whales successfully.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
